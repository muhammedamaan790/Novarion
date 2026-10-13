"""Sign-in (D-022): accounts file → every API route needs a session; no file → open API; brute force is throttled."""

import json

import pytest
from app.auth import (
    LOCKOUT_S,
    MAX_FAILURES,
    SESSION_COOKIE,
    SESSION_TTL_S,
    Authenticator,
    hash_password,
    save_users,
)
from app.main import create_app
from app.settings import Settings
from fastapi.testclient import TestClient

PASSWORD = "correct horse battery"  # test-only account, created in a temp dir


@pytest.fixture
def users_file(tmp_path):
    path = tmp_path / "users.json"
    save_users(path, {"clinician": hash_password(PASSWORD)})
    return path


@pytest.fixture
def client(users_file):
    return TestClient(create_app(Settings(mock=True, users_file=users_file)))


def login(client, username="clinician", password=PASSWORD):
    return client.post("/api/v1/auth/login", json={"username": username, "password": password})


def test_without_an_accounts_file_the_api_stays_open(tmp_path):
    open_client = TestClient(create_app(Settings(mock=True, users_file=tmp_path / "missing.json")))
    assert open_client.get("/api/v1/meta").status_code == 200
    assert open_client.get("/api/v1/auth/session").json() == {
        "auth_required": False, "accounts_configured": False, "user": None}


def test_every_route_needs_a_session_but_health_and_sign_in_do_not(client):
    for path in ("/api/v1/meta", "/api/v1/patients", "/api/v1/patients/ZAS-0001", "/api/v1/evaluation"):
        r = client.get(path)
        assert r.status_code == 401 and r.json()["error_code"] == "UNAUTHENTICATED", path
    assert client.post("/api/v1/predict", json={}).status_code == 401  # rejected before the body is even parsed
    assert client.get("/api/v1/health/live").status_code == 200
    assert client.get("/api/v1/health/ready").status_code == 200
    assert client.get("/api/v1/auth/session").json() == {
        "auth_required": True, "accounts_configured": True, "user": None}


def test_sign_in_sets_a_strict_http_only_cookie_and_sign_out_revokes_it(client):
    r = login(client)
    assert r.status_code == 200 and r.json()["user"] == "clinician"
    cookie = r.headers["set-cookie"]
    assert f"{SESSION_COOKIE}=" in cookie and "HttpOnly" in cookie and "SameSite=strict" in cookie
    assert "Path=/api/v1" in cookie
    assert client.get("/api/v1/meta").status_code == 200
    assert client.get("/api/v1/auth/session").json()["user"] == "clinician"
    token = client.cookies.get(SESSION_COOKIE)
    assert client.post("/api/v1/auth/logout").json()["user"] is None
    client.cookies.set(SESSION_COOKIE, token, path="/api/v1")  # replaying the old token must not work
    assert client.get("/api/v1/meta").status_code == 401


def test_wrong_password_unknown_user_and_bad_names_get_the_same_answer(client):
    for username, password in (("clinician", "wrong password"), ("nobody", PASSWORD), ("Bad Name!", PASSWORD)):
        r = login(client, username, password)
        assert r.status_code == 401 and r.json()["error_code"] == "INVALID_CREDENTIALS"
        assert r.json()["message"] == "Wrong username or password."
        assert "set-cookie" not in r.headers
    assert login(client, "  Clinician ").status_code == 200  # usernames are case- and space-insensitive


def test_repeated_failures_lock_the_account_even_for_the_right_password(client):
    for _ in range(MAX_FAILURES):
        assert login(client, password="guess").status_code == 401
    r = login(client)
    assert r.status_code == 429 and r.json()["error_code"] == "RATE_LIMITED"


def test_lockout_expires_and_sessions_expire():
    auth = Authenticator(None)
    auth.users = {"clinician": hash_password(PASSWORD)}
    for _ in range(MAX_FAILURES):
        assert auth.login("clinician", "guess", now=0.0) is None
    assert auth.retry_after("clinician", now=1.0) > 0
    assert auth.retry_after("clinician", now=LOCKOUT_S + 1) == 0
    token = auth.login("clinician", PASSWORD, now=LOCKOUT_S + 1)
    assert token and auth.user_for(token, now=LOCKOUT_S + 2) == "clinician"
    assert auth.user_for(token, now=LOCKOUT_S + 1 + SESSION_TTL_S) is None


def test_the_accounts_file_holds_salted_hashes_never_passwords(users_file):
    text = users_file.read_text(encoding="utf-8")
    assert PASSWORD not in text
    record = json.loads(text)["users"]["clinician"]
    assert set(record) == {"salt", "hash", "n", "r", "p"}
    assert hash_password(PASSWORD)["hash"] != record["hash"]  # a fresh salt every time


def test_auth_off_switch(monkeypatch, users_file):
    monkeypatch.setenv("NOVARION_USERS_FILE", str(users_file))
    assert Settings.from_env().users_file == users_file
    monkeypatch.setenv("NOVARION_AUTH", "off")
    assert Settings.from_env().users_file is None
