"""Manage sign-in accounts (D-022). Passwords are typed at a prompt and stored only as salted scrypt hashes.

Usage:
  uv run python scripts/users.py add <username>       # prompts twice for the password; replaces an existing one
  uv run python scripts/users.py add <username> --weak-ok   # local demo only: allows a password under 8 characters
  uv run python scripts/users.py remove <username>
  uv run python scripts/users.py list

The file is artifacts/users.json (gitignored; NOVARION_USERS_FILE overrides). Creating it turns sign-in on for the
backend at its next start; deleting it turns sign-in off.
"""

from __future__ import annotations

import getpass
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.auth import MIN_PASSWORD_CHARS, USERNAME_RE, hash_password, load_users, save_users


def main(argv: list[str]) -> int:
    path = Path(os.environ.get("NOVARION_USERS_FILE") or ROOT / "artifacts" / "users.json")
    users = load_users(path)
    if argv[:1] == ["list"]:
        print("\n".join(sorted(users)) or "(no accounts)")
        return 0
    weak_ok = "--weak-ok" in argv
    argv = [a for a in argv if a != "--weak-ok"]
    if len(argv) != 2 or argv[0] not in {"add", "remove"}:
        print(__doc__)
        return 2
    command, username = argv[0], argv[1].strip().lower()
    if command == "remove":
        if users.pop(username, None) is None:
            print(f"no account named {username}")
            return 1
        save_users(path, users)
        print(f"removed {username}")
        return 0
    if not USERNAME_RE.match(username):
        print("username: 3-32 characters, lowercase letters, digits, '.', '_' or '-'")
        return 1
    password = getpass.getpass(f"Password for {username}: ")
    if not password or (len(password) < MIN_PASSWORD_CHARS and not weak_ok):
        print(f"password must be at least {MIN_PASSWORD_CHARS} characters (--weak-ok allows less, for a local demo only)")
        return 1
    if len(password) < MIN_PASSWORD_CHARS:
        print("warning: weak password; never use this account on a server others can reach")
    if getpass.getpass("Repeat password: ") != password:
        print("passwords differ")
        return 1
    users[username] = hash_password(password)
    save_users(path, users)
    print(f"saved {username} in {path} (restart the backend to apply)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
