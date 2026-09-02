"""
backend/audit.py — Sistema de Auditoría Persistente en SQLite
Registra y consulta eventos de autenticación y cambios en reglas DHCP.
"""

import os
import sqlite3
import json
from datetime import datetime
from typing import Optional, List, Dict, Any

# Directorio de datos para persistencia (en raíz del proyecto o backend/data)
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "audit.db")


def get_db_connection() -> sqlite3.Connection:
    """Obtiene una conexión a la base de datos SQLite."""
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_audit_db():
    """Inicializa las tablas e índices de auditoría si no existen."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            user_email TEXT NOT NULL,
            user_name TEXT,
            event_type TEXT NOT NULL, -- LOGIN, LOGOUT, LOGIN_FAILED, CREATE, UPDATE, DELETE
            action_status TEXT DEFAULT 'SUCCESS', -- SUCCESS, FAILED
            target_mac TEXT,
            target_ip TEXT,
            description TEXT,
            details TEXT, -- JSON con detalles adicionales
            client_ip TEXT
        );
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp DESC);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_audit_user_email ON audit_logs(user_email);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit_logs(event_type);")
    conn.commit()
    conn.close()
    print(f"[Audit DB] Base de datos de auditoría lista en: {DB_PATH}")


def log_event(
    event_type: str,
    user_email: str,
    user_name: Optional[str] = None,
    action_status: str = "SUCCESS",
    target_mac: Optional[str] = None,
    target_ip: Optional[str] = None,
    description: Optional[str] = None,
    details: Optional[Dict[str, Any]] = None,
    client_ip: Optional[str] = None,
) -> int:
    """Inserta un registro de auditoría en SQLite."""
    timestamp = datetime.now().isoformat()
    details_json = json.dumps(details, ensure_ascii=False) if details else None

    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute(
        """
        INSERT INTO audit_logs (
            timestamp, user_email, user_name, event_type, action_status,
            target_mac, target_ip, description, details, client_ip
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            timestamp,
            user_email.strip().lower() if user_email else "sistema",
            user_name or "",
            event_type.upper(),
            action_status.upper(),
            target_mac or "",
            target_ip or "",
            description or "",
            details_json,
            client_ip or "",
        ),
    )
    conn.commit()
    record_id = cursor.lastrowid
    conn.close()
    return record_id


def get_audit_logs(
    event_type: Optional[str] = None,
    user_email: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> Dict[str, Any]:
    """Obtiene logs filtrados con paginación."""
    conn = get_db_connection()
    cursor = conn.cursor()

    conditions = []
    params = []

    if event_type and event_type.upper() != "ALL":
        conditions.append("event_type = ?")
        params.append(event_type.upper())

    if user_email and user_email.strip():
        conditions.append("user_email = ?")
        params.append(user_email.strip().lower())

    if search and search.strip():
        s = f"%{search.strip().lower()}%"
        conditions.append("""
            (LOWER(user_email) LIKE ? 
             OR LOWER(user_name) LIKE ? 
             OR LOWER(target_mac) LIKE ? 
             OR LOWER(target_ip) LIKE ? 
             OR LOWER(description) LIKE ?
             OR LOWER(details) LIKE ?)
        """)
        params.extend([s, s, s, s, s, s])

    where_clause = " WHERE " + " AND ".join(conditions) if conditions else ""

    # Total count
    cursor.execute(f"SELECT COUNT(*) as total FROM audit_logs{where_clause}", params)
    total = cursor.fetchone()["total"]

    # Registros paginados
    query = f"""
        SELECT id, timestamp, user_email, user_name, event_type, action_status,
               target_mac, target_ip, description, details, client_ip
        FROM audit_logs
        {where_clause}
        ORDER BY id DESC
        LIMIT ? OFFSET ?
    """
    cursor.execute(query, params + [limit, offset])
    rows = cursor.fetchall()

    logs = []
    for r in rows:
        item = dict(r)
        if item.get("details"):
            try:
                item["details"] = json.loads(item["details"])
            except Exception:
                pass
        logs.append(item)

    conn.close()

    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "logs": logs,
    }


def get_audit_users() -> List[Dict[str, str]]:
    """Obtiene la lista de usuarios únicos registrados en los logs."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT DISTINCT user_email, user_name
        FROM audit_logs
        WHERE user_email != 'sistema'
        ORDER BY user_email ASC
    """)
    rows = cursor.fetchall()
    users = [dict(r) for r in rows]
    conn.close()
    return users
