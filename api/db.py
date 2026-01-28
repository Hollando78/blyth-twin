"""
Database connection management for the API.
"""

import os
from contextlib import contextmanager
from typing import Generator

import psycopg2
from psycopg2.pool import ThreadedConnectionPool

# Connection pool
_pool: ThreadedConnectionPool | None = None


def get_db_config() -> dict:
    """Get database configuration from environment."""
    return {
        "host": os.environ.get("PGHOST", "localhost"),
        "database": os.environ.get("PGDATABASE", "blyth_twin"),
        "user": os.environ.get("PGUSER", "postgres"),
        "password": os.environ.get("PGPASSWORD", "blyth123"),
        "port": int(os.environ.get("PGPORT", 5432))
    }


def init_db():
    """Initialize the connection pool."""
    global _pool
    if _pool is None:
        config = get_db_config()
        _pool = ThreadedConnectionPool(
            minconn=2,
            maxconn=10,
            **config
        )
        print(f"Database pool initialized: {config['host']}:{config['port']}/{config['database']}")


def close_db():
    """Close the connection pool."""
    global _pool
    if _pool is not None:
        _pool.closeall()
        _pool = None
        print("Database pool closed")


def get_connection():
    """Get a connection from the pool."""
    global _pool
    if _pool is None:
        init_db()
    return _pool.getconn()


def release_connection(conn):
    """Return a connection to the pool."""
    global _pool
    if _pool is not None:
        _pool.putconn(conn)


@contextmanager
def get_db() -> Generator:
    """Context manager for database connections."""
    conn = get_connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        release_connection(conn)


def get_cursor(conn):
    """Get a cursor that returns dictionaries."""
    from psycopg2.extras import RealDictCursor
    return conn.cursor(cursor_factory=RealDictCursor)
