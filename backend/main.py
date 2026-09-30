"""
backend/main.py
FastAPI backend para gestión de arrendamientos DHCP del FortiGate (V170 - 192.168.171.x)
Usa la API REST de FortiOS v2 con Bearer Token (igual que backup_fortigate.py)
"""

import ipaddress
import os
import urllib.parse
from contextlib import asynccontextmanager
from typing import Optional

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, field_validator

from backend.audit import init_audit_db, log_event, get_audit_logs, get_audit_users

load_dotenv()

# ─── Configuración desde .env ──────────────────────────────────────────────────
FGT_HOST = os.getenv("FGT_HOST", "192.168.99.99")
FGT_PORT = os.getenv("FGT_PORT", "8443")
FGT_TOKEN = os.getenv("FGT_TOKEN", "bxtQkG7mymccqqc1wgwQyH7ngb4nbb")
DHCP_SERVER_ID = int(os.getenv("DHCP_SERVER_ID", "24"))
V170_START_IP = os.getenv("V170_START_IP", "192.168.171.1")
V170_END_IP = os.getenv("V170_END_IP", "192.168.171.254")

FGT_BASE_URL = f"https://{FGT_HOST}:{FGT_PORT}"
DHCP_URL = f"{FGT_BASE_URL}/api/v2/cmdb/system.dhcp/server/{DHCP_SERVER_ID}"
STATUS_URL = f"{FGT_BASE_URL}/api/v2/monitor/system/status"
FW_ADDRESS_URL = f"{FGT_BASE_URL}/api/v2/cmdb/firewall/address"
FW_ADDRGRP_URL = f"{FGT_BASE_URL}/api/v2/cmdb/firewall/addrgrp"

PRINTER_GROUPS = {
    "ini": {
        "group_name": "CLIENT_PRINT_INI",
        "policy_id": 55,
        "policy_name": "ACC_PRINTER_INI",
        "vlan": 210,
        "label": "Inicial (VLAN 210)",
    },
    "pri": {
        "group_name": "CLIENT_PRINT_PRI",
        "policy_id": 54,
        "policy_name": "ACC_PRINTER_PRI",
        "vlan": 220,
        "label": "Primaria (VLAN 220)",
    },
    "sec": {
        "group_name": "CLIENT_PRINT_SEC",
        "policy_id": 53,
        "policy_name": "ACC_PRINTER_SEC",
        "vlan": 230,
        "label": "Secundaria (VLAN 230)",
    },
}

HEADERS = {
    "Authorization": f"Bearer {FGT_TOKEN}",
    "Content-Type": "application/json",
}

# Verificación SSL configurable (False por defecto para certificados autofirmados de appliances internos)
FGT_VERIFY_SSL = os.getenv("FGT_VERIFY_SSL", "false").lower() in ("true", "1", "yes")

# Cliente httpx compartido
http_client: httpx.AsyncClient = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Gestiona el ciclo de vida del cliente HTTP y base de datos de auditoría."""
    global http_client
    http_client = httpx.AsyncClient(verify=FGT_VERIFY_SSL, timeout=30.0)  # nosec B501
    init_audit_db()
    print(f"[FortiGate API] Backend iniciado -> {FGT_BASE_URL}")
    print(f"[FortiGate API] DHCP Server ID: {DHCP_SERVER_ID} | Rango V170: {V170_START_IP} - {V170_END_IP}")
    yield
    await http_client.aclose()
    print("[FortiGate API] Backend cerrado")


app = FastAPI(
    title="FortiGate DHCP Manager API",
    description="Gestión de arrendamientos DHCP V170 vía API REST de FortiOS",
    version="2.0.0",
    lifespan=lifespan,
)

# CORS — permite peticiones del frontend Node.js
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Modelos Pydantic ──────────────────────────────────────────────────────────

class DhcpReservation(BaseModel):
    mac: str
    ip: Optional[str] = ""
    description: Optional[str] = ""
    type: Optional[str] = "mac"
    action: Optional[str] = "assign-ip"  # "assign-ip", "block", "reserved"

    @field_validator("mac")
    @classmethod
    def validate_mac(cls, v: str) -> str:
        v = v.strip().lower()
        v = v.replace("-", ":").replace(".", ":")
        # Si viene plano sin delimitadores (ej: 00155daea3a0)
        if len(v) == 12 and all(c in "0123456789abcdef" for c in v):
            v = ":".join(v[i:i+2] for i in range(0, 12, 2))
        parts = v.split(":")
        if len(parts) != 6 or not all(len(p) == 2 and all(c in "0123456789abcdef" for c in p) for p in parts):
            raise ValueError(f"Dirección MAC inválida: {v}")
        return v

    @field_validator("ip")
    @classmethod
    def validate_ip(cls, v: Optional[str]) -> str:
        val = (v or "").strip()
        if not val or val == "0.0.0.0":
            return val or "0.0.0.0"
        try:
            ipaddress.IPv4Address(val)
        except ValueError:
            raise ValueError(f"Dirección IP inválida: {val}")
        return val

    @field_validator("action")
    @classmethod
    def validate_action(cls, v: Optional[str]) -> str:
        val = (v or "assign").strip().lower()
        if val in ("assign", "assign-ip"):
            return "assign"
        elif val == "reserved":
            return "reserved"
        return "assign"


class DhcpReservationUpdate(BaseModel):
    ip: Optional[str] = None
    description: Optional[str] = None
    action: Optional[str] = None
    type: Optional[str] = None

    @field_validator("action")
    @classmethod
    def validate_action(cls, v: Optional[str]) -> Optional[str]:
        if v is not None:
            val = v.strip().lower()
            if val in ("assign", "assign-ip"):
                return "assign"
            elif val == "reserved":
                return "reserved"
            return "assign"
        return v

    @field_validator("ip")
    @classmethod
    def validate_ip(cls, v: Optional[str]) -> Optional[str]:
        if v is not None:
            val = v.strip()
            if val and val != "0.0.0.0":
                try:
                    ipaddress.IPv4Address(val)
                except ValueError:
                    raise ValueError(f"Dirección IP inválida: {val}")
            return val or "0.0.0.0"
        return v


class AuditEventIn(BaseModel):
    event_type: str
    user_email: Optional[str] = None
    user_name: Optional[str] = None
    action_status: str = "SUCCESS"
    target_mac: Optional[str] = None
    target_ip: Optional[str] = None
    description: Optional[str] = None
    details: Optional[dict] = None
    client_ip: Optional[str] = None


class PrinterPermissionIn(BaseModel):
    mac: str
    description: Optional[str] = ""
    ini: bool = False
    pri: bool = False
    sec: bool = False

    @field_validator("mac")
    @classmethod
    def validate_mac(cls, v: str) -> str:
        v = v.strip().lower()
        v = v.replace("-", ":").replace(".", ":")
        if len(v) == 12 and all(c in "0123456789abcdef" for c in v):
            v = ":".join(v[i:i+2] for i in range(0, 12, 2))
        parts = v.split(":")
        if len(parts) != 6 or not all(len(p) == 2 and all(c in "0123456789abcdef" for c in p) for p in parts):
            raise ValueError(f"Dirección MAC inválida: {v}")
        return v


def _extract_actor(request: Request) -> dict:
    email = request.headers.get("x-user-email", "").strip()
    raw_name = request.headers.get("x-user-name", "").strip()
    name = urllib.parse.unquote(raw_name) if raw_name else ""
    client_ip = request.headers.get("x-user-ip", "").strip()
    if not client_ip and request.client:
        client_ip = request.client.host
    return {
        "email": email or "sistema",
        "name": name or "",
        "ip": client_ip or "",
    }


# ─── Helpers ──────────────────────────────────────────────────────────────────

async def _get_dhcp_server() -> dict:
    """Obtiene la configuración completa del servidor DHCP desde FortiGate."""
    try:
        resp = await http_client.get(DHCP_URL, headers=HEADERS)
    except httpx.RequestError as e:
        raise HTTPException(status_code=503, detail=f"No se puede conectar al FortiGate: {e}")

    if resp.status_code == 401:
        raise HTTPException(status_code=401, detail="Token de API inválido o expirado")
    if resp.status_code == 404:
        raise HTTPException(status_code=404, detail=f"DHCP Server ID {DHCP_SERVER_ID} no encontrado")
    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail=f"Error FortiGate API: {resp.text[:200]}")

    data = resp.json()
    results = data.get("results", [])
    if not results:
        raise HTTPException(status_code=404, detail=f"DHCP Server ID {DHCP_SERVER_ID} sin datos")
    return results[0]


def _clean_entries_for_fortigate(entries: list) -> list:
    """
    Prepara la lista de reserved-address para enviar a FortiGate.
    - Si action == 'reserved': incluye 'ip' (IP estática obligatoria).
    - Si action == 'assign-ip': NO incluye la clave 'ip' para evitar el error 'IP address can not be 0'.
    - 'description': hasta 255 chars.
    - 'type': 'mac'.
    """
    cleaned = []
    for e in entries:
        action = e.get("action", "assign-ip")
        if action not in ("assign-ip", "reserved"):
            action = "assign-ip"

        item = {
            "id": e["id"],
            "mac": e["mac"],
            "type": e.get("type", "mac"),
            "action": action,
            "description": (e.get("description") or "").strip()[:255],
        }

        # Solo si es 'reserved' y tiene una IP válida distinta de 0.0.0.0 se envía 'ip'
        ip_val = (e.get("ip") or "").strip()
        if action == "reserved" and ip_val and ip_val != "0.0.0.0":
            item["ip"] = ip_val
        # Para 'assign-ip', NUNCA se envía la clave 'ip'

        cleaned.append(item)
    return cleaned


async def _save_reserved_addresses(entries: list) -> dict:
    """
    Actualiza ÚNICAMENTE la subtabla reserved-address en FortiGate.
    No re-envía otros campos del servidor DHCP (evita errores de CLI como 'Domain name is not valid').
    """
    clean_entries = _clean_entries_for_fortigate(entries)
    payload = {
        "reserved-address": clean_entries
    }

    try:
        resp = await http_client.put(DHCP_URL, headers=HEADERS, json=payload)
    except httpx.RequestError as e:
        raise HTTPException(status_code=503, detail=f"No se puede conectar al FortiGate: {e}")

    if resp.status_code not in (200, 201):
        raise HTTPException(
            status_code=resp.status_code,
            detail=f"Error al actualizar DHCP en FortiGate: {resp.text[:300]}",
        )
    return resp.json()


def _normalize_reserved(entries: list) -> list:
    """Normaliza y ordena las reservas del DHCP."""
    result = []
    for e in entries:
        raw_action = (e.get("action") or "").strip().lower()
        ip_val = (e.get("ip") or "").strip()
        if ip_val == "0.0.0.0":
            ip_val = ""

        if raw_action in ("assign", "assign-ip"):
            action = "assign"
            final_ip = ""
        elif raw_action == "reserved" or ip_val:
            action = "reserved"
            final_ip = ip_val
        else:
            action = "assign"
            final_ip = ""

        result.append({
            "id": e.get("id"),
            "mac": e.get("mac", ""),
            "ip": final_ip,
            "description": e.get("description", ""),
            "type": e.get("type", "mac"),
            "action": action,
        })
    # Ordenar por IP o por ID si no tiene IP
    result.sort(key=lambda x: (ipaddress.IPv4Address(x["ip"]) if x["ip"] else ipaddress.IPv4Address("0.0.0.0"), x.get("id") or 0))
    return result


def _next_entry_id(entries: list) -> int:
    """Calcula el próximo ID disponible para una entrada DHCP."""
    existing = {e.get("id", 0) for e in entries}
    i = 1
    while i in existing:
        i += 1
    return i


def _get_used_ips(entries: list) -> set:
    return {e.get("ip", "") for e in entries if e.get("ip")}


def _get_used_macs(entries: list) -> set:
    return {e.get("mac", "").lower() for e in entries if e.get("mac")}


# ─── Endpoints ────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    """Heartbeat del backend Python."""
    return {"status": "ok", "dhcp_server_id": DHCP_SERVER_ID, "fortigate": FGT_HOST}


@app.get("/system/status")
async def get_system_status():
    """Información del sistema FortiGate (modelo, firmware, hostname)."""
    try:
        resp = await http_client.get(STATUS_URL, headers=HEADERS)
    except httpx.RequestError as e:
        raise HTTPException(status_code=503, detail=f"No se puede conectar al FortiGate: {e}")

    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail="Error al obtener estado del FortiGate")

    data = resp.json()
    results = data.get("results", {})

    model_name = results.get("model_name", "FortiGate")
    model_number = results.get("model_number", "")
    model = f"{model_name}-{model_number}" if model_number else model_name

    firmware = data.get("version", results.get("version", "vUnknown"))
    build = data.get("build", results.get("build", ""))
    full_version = f"{firmware} build {build}" if build else firmware

    hostname = results.get("hostname", FGT_HOST)

    return {
        "model": model,
        "firmware": full_version,
        "hostname": hostname,
        "host": FGT_HOST,
        "port": FGT_PORT,
        "dhcp_server_id": DHCP_SERVER_ID,
        "v170_range": f"{V170_START_IP} - {V170_END_IP}",
    }


@app.get("/dhcp/reservations")
async def get_reservations(
    search: Optional[str] = Query(None, description="Filtro por MAC, IP o descripción"),
):
    """
    Lista todas las reservas del servidor DHCP V170.
    Permite filtrar por MAC, IP o descripción.
    """
    server = await _get_dhcp_server()
    entries = server.get("reserved-address", [])
    normalized = _normalize_reserved(entries)

    if search:
        s = search.strip().lower()
        normalized = [
            r for r in normalized
            if s in r["mac"].lower()
            or s in r["ip"].lower()
            or s in (r["description"] or "").lower()
        ]

    return {
        "count": len(normalized),
        "total": len(entries),
        "dhcp_server_id": DHCP_SERVER_ID,
        "reservations": normalized,
    }


@app.post("/dhcp/reservations", status_code=201)
async def create_reservation(reservation: DhcpReservation, request: Request):
    """
    Crea una nueva regla de asignación/reserva DHCP.
    Soporta action (assign, reserved), type (mac) y description.
    """
    server = await _get_dhcp_server()
    entries: list = server.get("reserved-address", [])

    used_macs = _get_used_macs(entries)
    used_ips = _get_used_ips(entries)

    if reservation.mac.lower() in used_macs:
        raise HTTPException(status_code=409, detail=f"La MAC {reservation.mac} ya tiene una regla configurada")

    action = "reserved" if reservation.action == "reserved" else "assign"
    target_ip = reservation.ip.strip() if reservation.ip else ""
    if action == "assign":
        target_ip = ""
    elif action == "reserved":
        if not target_ip or target_ip == "0.0.0.0":
            raise HTTPException(status_code=422, detail="La dirección IP es obligatoria para Reserve IP")
        if target_ip in used_ips:
            raise HTTPException(status_code=409, detail=f"La IP {target_ip} ya está asignada")

    new_id = _next_entry_id(entries)
    new_entry = {
        "id": new_id,
        "mac": reservation.mac,
        "ip": target_ip,
        "description": (reservation.description or "").strip()[:255],
        "type": reservation.type or "mac",
        "action": action,
    }
    clean_item = {
        "id": new_id,
        "mac": reservation.mac,
        "type": reservation.type or "mac",
        "action": action,
        "description": (reservation.description or "").strip()[:255],
    }
    if action == "reserved" and target_ip:
        clean_item["ip"] = target_ip

    # Intentar creación atómica vía POST a la subtabla /reserved-address (evita que FortiOS requiera campo ip en assign)
    created_via_subtable = False
    try:
        post_resp = await http_client.post(f"{DHCP_URL}/reserved-address", headers=HEADERS, json=clean_item)
        if post_resp.status_code in (200, 201):
            created_via_subtable = True
        else:
            print(f"[FortiGate API] POST subtabla falló ({post_resp.status_code}): {post_resp.text[:200]}")
    except Exception as e:
        print(f"[FortiGate API] Error en POST subtabla: {e}")

    if not created_via_subtable:
        # Fallback al guardado tradicional
        await _save_reserved_addresses(entries)

    actor = _extract_actor(request)
    log_event(
        event_type="CREATE",
        user_email=actor["email"],
        user_name=actor["name"],
        action_status="SUCCESS",
        target_mac=reservation.mac,
        target_ip=target_ip or "Dinámica (Pool)",
        description=reservation.description or "",
        details={
            "id": new_id,
            "action": action,
            "type": reservation.type or "mac",
        },
        client_ip=actor["ip"],
    )

    action_label = "asignada dinámica (Pool)" if action == "assign" else f"reservada a {target_ip}"
    return {
        "success": True,
        "message": f"Regla creada: {reservation.mac} ({action_label})",
        "entry": _normalize_reserved([new_entry])[0],
    }


@app.put("/dhcp/reservations/{entry_id}")
async def update_reservation(entry_id: int, update: DhcpReservationUpdate, request: Request):
    """
    Actualiza IP, descripción o acción de una regla existente.
    """
    server = await _get_dhcp_server()
    entries: list = server.get("reserved-address", [])

    # Encontrar la entrada
    target = next((e for e in entries if e.get("id") == entry_id), None)
    if target is None:
        raise HTTPException(status_code=404, detail=f"Reserva ID {entry_id} no encontrada")

    used_ips = _get_used_ips(entries)

    old_action = target.get("action") or "assign"
    old_ip = target.get("ip") or ""
    old_desc = target.get("description") or ""

    current_action = old_action
    if current_action in ("assign", "assign-ip"):
        current_action = "assign"

    new_action = update.action if update.action is not None else current_action
    if new_action in ("assign", "assign-ip"):
        new_action = "assign"

    target["action"] = new_action

    if new_action == "assign":
        target["ip"] = ""
    elif new_action == "reserved" and update.ip is not None:
        new_ip = update.ip.strip()
        if not new_ip or new_ip == "0.0.0.0":
            raise HTTPException(status_code=422, detail="La dirección IP es obligatoria para Reserve IP")
        if new_ip in used_ips and new_ip != target.get("ip"):
            raise HTTPException(status_code=409, detail=f"La IP {new_ip} ya está asignada")
        target["ip"] = new_ip

    if update.description is not None:
        target["description"] = update.description.strip()[:255]

    if update.type is not None:
        target["type"] = update.type

    # Para garantizar que en FortiOS la IP estática no quede guardada si se cambia a 'assign':
    item_url = f"{DHCP_URL}/reserved-address/{entry_id}"
    clean_item = {
        "id": target["id"],
        "mac": target["mac"],
        "type": target.get("type", "mac"),
        "action": new_action,
        "description": target.get("description", "")[:255],
    }
    if new_action == "reserved" and target.get("ip"):
        clean_item["ip"] = target["ip"]

    actor = _extract_actor(request)
    audit_details = {
        "id": entry_id,
        "previous": {
            "action": old_action,
            "ip": old_ip or "Dinámica (Pool)",
            "description": old_desc,
        },
        "updated": {
            "action": new_action,
            "ip": target.get("ip") or "Dinámica (Pool)",
            "description": target.get("description", ""),
        },
    }

    if new_action == "assign":
        try:
            del_resp = await http_client.delete(item_url, headers=HEADERS)
            print(f"[FortiGate API] Delete previo para entry {entry_id}: {del_resp.status_code}")
            post_resp = await http_client.post(f"{DHCP_URL}/reserved-address", headers=HEADERS, json=clean_item)
            print(f"[FortiGate API] Recrear entry {entry_id} como assign: {post_resp.status_code}")
            if post_resp.status_code in (200, 201):
                log_event(
                    event_type="UPDATE",
                    user_email=actor["email"],
                    user_name=actor["name"],
                    action_status="SUCCESS",
                    target_mac=target["mac"],
                    target_ip="Dinámica (Pool)",
                    description=target.get("description", ""),
                    details=audit_details,
                    client_ip=actor["ip"],
                )
                return {
                    "success": True,
                    "message": f"Regla ID {entry_id} actualizada a Assign IP (Dinámica)",
                    "entry": _normalize_reserved([target])[0],
                }
        except Exception as e:
            print(f"[FortiGate API] Subtabla delete/post error: {e}")

    # Fallback general con la subtabla completa limpia
    await _save_reserved_addresses(entries)

    log_event(
        event_type="UPDATE",
        user_email=actor["email"],
        user_name=actor["name"],
        action_status="SUCCESS",
        target_mac=target["mac"],
        target_ip=target.get("ip") or "Dinámica (Pool)",
        description=target.get("description", ""),
        details=audit_details,
        client_ip=actor["ip"],
    )

    return {
        "success": True,
        "message": f"Regla ID {entry_id} actualizada",
        "entry": _normalize_reserved([target])[0],
    }


@app.delete("/dhcp/reservations/{entry_id}")
async def delete_reservation(entry_id: int, request: Request):
    """
    Elimina una reserva DHCP por su ID interno.
    """
    server = await _get_dhcp_server()
    entries: list = server.get("reserved-address", [])

    target = next((e for e in entries if e.get("id") == entry_id), None)
    if target is None:
        raise HTTPException(status_code=404, detail=f"Reserva ID {entry_id} no encontrada")

    mac = target.get("mac", "")
    raw_ip = (target.get("ip") or "").strip()
    action = (target.get("action") or "").strip().lower()
    ip_display = raw_ip if (action == "reserved" and raw_ip and raw_ip != "0.0.0.0") else "Dinámica (Pool)"
    desc = target.get("description", "")

    # Intentar borrado atómico de la entrada en la subtabla de FortiOS
    item_url = f"{DHCP_URL}/reserved-address/{entry_id}"
    deleted_via_subtable = False
    try:
        del_resp = await http_client.delete(item_url, headers=HEADERS)
        if del_resp.status_code in (200, 201):
            deleted_via_subtable = True
        else:
            print(f"[FortiGate API] DELETE subtabla falló ({del_resp.status_code}): {del_resp.text[:200]}")
    except Exception as e:
        print(f"[FortiGate API] Error en DELETE subtabla: {e}")

    if not deleted_via_subtable:
        entries = [e for e in entries if e.get("id") != entry_id]
        await _save_reserved_addresses(entries)

    actor = _extract_actor(request)
    log_event(
        event_type="DELETE",
        user_email=actor["email"],
        user_name=actor["name"],
        action_status="SUCCESS",
        target_mac=mac,
        target_ip=ip_display,
        description=desc,
        details={"id": entry_id, "action": action},
        client_ip=actor["ip"],
    )

    return {
        "success": True,
        "message": f"Reserva eliminada: {mac} → {ip_display}",
    }


@app.get("/dhcp/available-ips")
async def get_available_ips(limit: int = Query(20, ge=1, le=100)):
    """
    Calcula las primeras `limit` IPs libres en el rango V170.
    """
    server = await _get_dhcp_server()
    entries = server.get("reserved-address", [])
    used = _get_used_ips(entries)

    start = ipaddress.IPv4Address(V170_START_IP)
    end = ipaddress.IPv4Address(V170_END_IP)

    available = []
    current = start
    while current <= end and len(available) < limit:
        if str(current) not in used:
            available.append(str(current))
        current += 1

    return {
        "range": f"{V170_START_IP} - {V170_END_IP}",
        "used_count": len(used),
        "available": available,
    }


@app.get("/dhcp/stats")
async def get_dhcp_stats():
    """Estadísticas del pool DHCP V170."""
    server = await _get_dhcp_server()
    entries = server.get("reserved-address", [])

    start = ipaddress.IPv4Address(V170_START_IP)
    end = ipaddress.IPv4Address(V170_END_IP)
    total_pool = int(end) - int(start) + 1

    # Reservas con IP fija en el rango V170
    v170_entries = [
        e for e in entries
        if e.get("ip") and e.get("ip") != "0.0.0.0"
        and start <= ipaddress.IPv4Address(e["ip"]) <= end
    ]
    # Reservas sin IP (solo MAC registrada)
    mac_only = [e for e in entries if not e.get("ip") or e.get("ip") == "0.0.0.0"]

    used_ips = len(v170_entries)
    available = max(0, total_pool - used_ips)
    util_pct = round((used_ips / total_pool) * 100, 1) if total_pool else 0

    return {
        "dhcp_server_id": DHCP_SERVER_ID,
        "pool_range": f"{V170_START_IP} - {V170_END_IP}",
        "total_addresses": total_pool,
        "total_entries": len(entries),
        "reserved_v170": used_ips,
        "reserved": used_ips,           # alias para compatibilidad frontend
        "mac_only": len(mac_only),
        "available": available,
        "utilization_pct": util_pct,
    }


# ─── Endpoints de Auditoría ───────────────────────────────────────────────────

@app.get("/audit/logs")
async def fetch_audit_logs(
    event_type: Optional[str] = Query(None),
    user_email: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """Retorna los logs de auditoría filtrados con paginación."""
    return get_audit_logs(
        event_type=event_type,
        user_email=user_email,
        search=search,
        limit=limit,
        offset=offset,
    )


@app.get("/audit/users")
async def fetch_audit_users():
    """Retorna la lista de usuarios únicos registrados en la auditoría."""
    return {"users": get_audit_users()}


@app.post("/audit/event")
async def record_audit_event(event: AuditEventIn, request: Request):
    """Registra eventos de autenticación (login, logout, intentos fallidos) desde Node."""
    actor = _extract_actor(request)
    email = event.user_email or actor["email"]
    name = event.user_name or actor["name"]
    client_ip = event.client_ip or actor["ip"]

    record_id = log_event(
        event_type=event.event_type,
        user_email=email,
        user_name=name,
        action_status=event.action_status,
        target_mac=event.target_mac,
        target_ip=event.target_ip,
        description=event.description,
        details=event.details,
        client_ip=client_ip,
    )
    return {"success": True, "id": record_id}


# ─── Endpoints de Acceso a Impresoras (Firewall Address & Addrgrp) ─────────────

def _mac_to_object_name(mac: str) -> str:
    """Convierte una MAC en un nombre estándar de objeto en FortiOS: MAC_AABBCCDDEEFF"""
    clean = mac.replace(":", "").replace("-", "").replace(".", "").upper()
    return f"MAC_{clean}"


async def _get_address_group_members(group_name: str) -> list:
    """Obtiene los nombres de los miembros de un grupo de direcciones en FortiOS."""
    url = f"{FW_ADDRGRP_URL}/{group_name}"
    try:
        resp = await http_client.get(url, headers=HEADERS)
        if resp.status_code == 200:
            data = resp.json()
            results = data.get("results", [])
            if results:
                members = results[0].get("member", [])
                return [m.get("name") for m in members if isinstance(m, dict) and m.get("name")]
        return []
    except Exception as e:
        print(f"[FortiGate API] Error obteniendo grupo {group_name}: {e}")
        return []


async def _get_address_object(obj_name: str) -> Optional[dict]:
    """Obtiene un objeto firewall address por nombre."""
    url = f"{FW_ADDRESS_URL}/{obj_name}"
    try:
        resp = await http_client.get(url, headers=HEADERS)
        if resp.status_code == 200:
            results = resp.json().get("results", [])
            return results[0] if results else None
        return None
    except Exception as e:
        print(f"[FortiGate API] Error consultando objeto {obj_name}: {e}")
        return None


async def _ensure_address_object(obj_name: str, mac: str, comment: str = "") -> tuple[bool, str]:
    """
    Crea o actualiza el objeto firewall address de tipo MAC en FortiOS.
    En FortiOS API cmdb/firewall/address con type='mac', macaddr se puede enviar como string o array de dicts: [{"macaddr": mac}].
    Retorna (success: bool, error_message: str).
    """
    url = f"{FW_ADDRESS_URL}/{obj_name}"
    comment_clean = (comment or "").strip()[:255]
    try:
        # Verificar si ya existe
        check = await http_client.get(url, headers=HEADERS)
        if check.status_code == 200:
            if comment_clean:
                await http_client.put(url, headers=HEADERS, json={"comment": comment_clean})
            return True, ""
        
        # Probar payload con macaddr directo
        payload = {
            "name": obj_name,
            "type": "mac",
            "macaddr": [{"macaddr": mac}],
            "comment": comment_clean,
        }
        create_resp = await http_client.post(FW_ADDRESS_URL, headers=HEADERS, json=payload)
        
        # Si el schema prefiere string plano:
        if create_resp.status_code not in (200, 201):
            payload_str = {
                "name": obj_name,
                "type": "mac",
                "macaddr": mac,
                "comment": comment_clean,
            }
            create_resp2 = await http_client.post(FW_ADDRESS_URL, headers=HEADERS, json=payload_str)
            if create_resp2.status_code in (200, 201):
                return True, ""
            err_msg = create_resp2.text[:250]
            print(f"[FortiGate API] Error creando objeto {obj_name} ({create_resp2.status_code}): {err_msg}")
            return False, f"HTTP {create_resp2.status_code}: {err_msg}"

        return True, ""
    except Exception as e:
        print(f"[FortiGate API] Excepción asegurando objeto {obj_name}: {e}")
        return False, str(e)


async def _set_group_members(group_name: str, members: list) -> bool:
    """Actualiza la lista completa de miembros de un grupo de direcciones."""
    member_payload = [{"name": m} for m in members]
    url = f"{FW_ADDRGRP_URL}/{group_name}"
    try:
        resp = await http_client.put(url, headers=HEADERS, json={"member": member_payload})
        return resp.status_code in (200, 201)
    except Exception as e:
        print(f"[FortiGate API] Error actualizando miembros de {group_name}: {e}")
        return False


@app.get("/printers/permissions")
async def get_printer_permissions():
    """
    Lista todos los dispositivos con acceso a impresoras y sus membresías en los grupos:
    - CLIENT_PRINT_INI (VLAN 210)
    - CLIENT_PRINT_PRI (VLAN 220)
    - CLIENT_PRINT_SEC (VLAN 230)
    """
    # 1. Consultar miembros actuales de los 3 grupos
    group_members = {}
    for key, info in PRINTER_GROUPS.items():
        group_members[key] = await _get_address_group_members(info["group_name"])

    # 2. Obtener lista de todos los objetos MAC únicos en cualquiera de los 3 grupos
    all_obj_names = set()
    for mem_list in group_members.values():
        all_obj_names.update(mem_list)

    # 3. También buscar información de arrendamientos DHCP para enriquecer nombres/IPs
    dhcp_map = {}
    try:
        dhcp_server = await _get_dhcp_server()
        dhcp_entries = dhcp_server.get("reserved-address", [])
        dhcp_map = {e.get("mac", "").lower(): e for e in dhcp_entries if e.get("mac")}
    except Exception as e:
        print(f"[FortiGate API] Aviso: No se pudo obtener DHCP para enriquecer impresoras: {e}")

    devices = []
    for obj_name in sorted(all_obj_names):
        try:
            obj_data = await _get_address_object(obj_name)
        except Exception:
            obj_data = None

        mac = ""
        description = ""
        if obj_data:
            raw_mac = obj_data.get("macaddr")
            if isinstance(raw_mac, list) and len(raw_mac) > 0:
                first = raw_mac[0]
                mac = (first.get("macaddr") if isinstance(first, dict) else str(first)).lower()
            elif isinstance(raw_mac, str):
                mac = raw_mac.lower()
            description = obj_data.get("comment", "")
        
        # Si el objeto no traía macaddr, deducirlo del nombre MAC_AABBCCDDEEFF
        if not mac and obj_name.startswith("MAC_") and len(obj_name) == 16:
            raw_hex = obj_name[4:].lower()
            mac = ":".join(raw_hex[i:i+2] for i in range(0, 12, 2))

        # Enriquecer descripción con DHCP si no tenía comentario propio
        clean_mac_key = mac.lower() if mac else ""
        dhcp_match = dhcp_map.get(clean_mac_key)
        ip_assigned = dhcp_match.get("ip") if dhcp_match else ""
        if not description and dhcp_match and dhcp_match.get("description"):
            description = dhcp_match.get("description")

        devices.append({
            "object_name": obj_name,
            "mac": mac or obj_name,
            "ip": ip_assigned or "",
            "description": description or "",
            "ini": obj_name in group_members.get("ini", []),
            "pri": obj_name in group_members.get("pri", []),
            "sec": obj_name in group_members.get("sec", []),
        })

    # Resumen de estadísticas por grupo
    summary = {
        "ini_count": len(group_members["ini"]),
        "pri_count": len(group_members["pri"]),
        "sec_count": len(group_members["sec"]),
        "total_devices": len(devices),
        "groups": PRINTER_GROUPS,
    }

    return {
        "success": True,
        "summary": summary,
        "devices": devices,
    }


@app.get("/printers/candidates")
async def get_printer_candidates(q: Optional[str] = Query(None, description="Búsqueda por texto")):
    """
    Obtiene lista de candidatos de dispositivos MAC ya existentes para facilitar su selección rápida.
    Combina:
    1. Arrendamientos DHCP configurados en el FortiGate (V170).
    2. Objetos firewall address de tipo 'mac' o con prefijo 'MAC_' en FortiOS.
    """
    candidates = {}

    # 1. Obtener desde DHCP reservations
    try:
        server = await _get_dhcp_server()
        dhcp_entries = server.get("reserved-address", [])
        for e in dhcp_entries:
            raw_mac = e.get("mac", "").strip().lower()
            if raw_mac:
                candidates[raw_mac] = {
                    "mac": raw_mac,
                    "description": e.get("description", "") or "",
                    "ip": e.get("ip", "") or "",
                    "source": "DHCP V170",
                    "object_name": _mac_to_object_name(raw_mac),
                }
    except Exception as e:
        print(f"[FortiGate API] Error obteniendo DHCP para candidatos: {e}")

    # 2. Obtener desde objetos firewall address
    try:
        resp = await http_client.get(FW_ADDRESS_URL, headers=HEADERS)
        if resp.status_code == 200:
            addr_list = resp.json().get("results", [])
            for addr in addr_list:
                obj_name = addr.get("name", "")
                addr_type = addr.get("type", "")
                comment = addr.get("comment", "")

                mac = ""
                raw_mac = addr.get("macaddr")
                if isinstance(raw_mac, list) and len(raw_mac) > 0:
                    first = raw_mac[0]
                    mac = (first.get("macaddr") if isinstance(first, dict) else str(first)).strip().lower()
                elif isinstance(raw_mac, str) and raw_mac:
                    mac = raw_mac.strip().lower()

                # Si no tiene macaddr pero el nombre es MAC_...
                if not mac and obj_name.startswith("MAC_") and len(obj_name) == 16:
                    raw_hex = obj_name[4:].lower()
                    mac = ":".join(raw_hex[i:i+2] for i in range(0, 12, 2))

                if mac:
                    if mac in candidates:
                        # Completar descripción si faltaba
                        if not candidates[mac]["description"] and comment:
                            candidates[mac]["description"] = comment
                    else:
                        candidates[mac] = {
                            "mac": mac,
                            "description": comment or "",
                            "ip": "",
                            "source": "Objeto Firewall",
                            "object_name": obj_name,
                        }
    except Exception as e:
        print(f"[FortiGate API] Error obteniendo firewall address para candidatos: {e}")

    result_list = list(candidates.values())

    # Filtrar por búsqueda si se envió parámetro q
    if q:
        query = q.strip().lower()
        result_list = [
            c for c in result_list
            if query in c["mac"]
            or query in c["description"].lower()
            or query in c["ip"].lower()
            or query in c["object_name"].lower()
        ]

    # Ordenar por descripción / mac
    result_list.sort(key=lambda x: (x["description"] == "", x["description"].lower(), x["mac"]))

    return {
        "success": True,
        "count": len(result_list),
        "candidates": result_list,
    }


@app.post("/printers/permissions")
async def save_printer_permission(perm: PrinterPermissionIn, request: Request):

    """
    Crea o actualiza los permisos de un dispositivo en los 3 grupos de impresoras:
    - Asegura la existencia del Address Object en FortiOS.
    - Sincroniza su presencia en CLIENT_PRINT_INI, CLIENT_PRINT_PRI y CLIENT_PRINT_SEC.
    """
    actor = _extract_actor(request)
    mac = perm.mac.lower()
    obj_name = _mac_to_object_name(mac)

    # 1. Asegurar objeto MAC en firewall address
    obj_ok, obj_err = await _ensure_address_object(obj_name, mac, perm.description)
    if not obj_ok:
        raise HTTPException(
            status_code=502,
            detail=f"No se pudo crear o actualizar el objeto {obj_name} en el FortiGate: {obj_err}"
        )

    # 2. Sincronizar membresía en cada uno de los 3 grupos
    desired_membership = {
        "ini": perm.ini,
        "pri": perm.pri,
        "sec": perm.sec,
    }

    updated_groups = []
    for key, info in PRINTER_GROUPS.items():
        group_name = info["group_name"]
        current_members = await _get_address_group_members(group_name)
        should_be_in = desired_membership[key]
        is_in = obj_name in current_members

        if should_be_in and not is_in:
            current_members.append(obj_name)
            await _set_group_members(group_name, current_members)
            updated_groups.append(f"+{info['label']}")
        elif not should_be_in and is_in:
            current_members = [m for m in current_members if m != obj_name]
            await _set_group_members(group_name, current_members)
            updated_groups.append(f"-{info['label']}")

    # 3. Registrar en auditoría
    action_label = ", ".join(updated_groups) if updated_groups else "Sin cambios de grupos"
    log_event(
        event_type="PRINTER_PERM",
        user_email=actor["email"],
        user_name=actor["name"],
        action_status="SUCCESS",
        target_mac=mac,
        target_ip="Impresoras",
        description=perm.description or "Permisos de Impresora",
        details={
            "object_name": obj_name,
            "ini": perm.ini,
            "pri": perm.pri,
            "sec": perm.sec,
            "changes": action_label,
        },
        client_ip=actor["ip"],
    )

    return {
        "success": True,
        "message": f"Permisos actualizados para {mac} ({action_label})",
        "device": {
            "object_name": obj_name,
            "mac": mac,
            "description": perm.description,
            "ini": perm.ini,
            "pri": perm.pri,
            "sec": perm.sec,
        },
    }


@app.delete("/printers/permissions/{mac}")
async def revoke_printer_permissions(mac: str, request: Request):
    """
    Revoca todos los accesos de impresora de una dirección MAC:
    - La remueve de los grupos CLIENT_PRINT_INI, CLIENT_PRINT_PRI, CLIENT_PRINT_SEC.
    - Elimina el objeto firewall address asociado en FortiOS.
    """
    actor = _extract_actor(request)
    clean_mac = mac.strip().lower().replace("-", ":").replace(".", ":")
    obj_name = _mac_to_object_name(clean_mac)

    # 1. Remover de los 3 grupos
    for key, info in PRINTER_GROUPS.items():
        group_name = info["group_name"]
        current_members = await _get_address_group_members(group_name)
        if obj_name in current_members:
            current_members = [m for m in current_members if m != obj_name]
            await _set_group_members(group_name, current_members)

    # 2. Eliminar el objeto firewall address
    del_url = f"{FW_ADDRESS_URL}/{obj_name}"
    try:
        await http_client.delete(del_url, headers=HEADERS)
    except Exception as e:
        print(f"[FortiGate API] Error eliminando objeto {obj_name}: {e}")

    # 3. Auditoría
    log_event(
        event_type="PRINTER_REVOKE",
        user_email=actor["email"],
        user_name=actor["name"],
        action_status="SUCCESS",
        target_mac=clean_mac,
        target_ip="Impresoras",
        description=f"Revocados todos los accesos de impresora ({obj_name})",
        details={"object_name": obj_name},
        client_ip=actor["ip"],
    )

    return {
        "success": True,
        "message": f"Accesos de impresora revocados para {clean_mac}",
    }
