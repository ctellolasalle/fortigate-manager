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

HEADERS = {
    "Authorization": f"Bearer {FGT_TOKEN}",
    "Content-Type": "application/json",
}

# Cliente httpx compartido (SSL deshabilitado para certs auto-firmados, igual que backup_fortigate.py)
http_client: httpx.AsyncClient = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Gestiona el ciclo de vida del cliente HTTP y base de datos de auditoría."""
    global http_client
    http_client = httpx.AsyncClient(verify=False, timeout=30.0)
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
    entries.append(new_entry)

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
    ip = target.get("ip", "")
    desc = target.get("description", "")

    entries = [e for e in entries if e.get("id") != entry_id]
    await _save_reserved_addresses(entries)

    actor = _extract_actor(request)
    log_event(
        event_type="DELETE",
        user_email=actor["email"],
        user_name=actor["name"],
        action_status="SUCCESS",
        target_mac=mac,
        target_ip=ip or "Dinámica (Pool)",
        description=desc,
        details={"id": entry_id},
        client_ip=actor["ip"],
    )

    return {
        "success": True,
        "message": f"Reserva eliminada: {mac} → {ip or 'Dynamic'}",
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
