"""Explicit local owner administration; never starts the HTTP server or registration."""
import argparse
import getpass
from pathlib import Path
import sys
import warnings

# Direct-script administration must not create application bytecode directories.
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tracker_config.models import ConfigurationError
from tracker_config.security import owner_repository, normalize_username, verify_password


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        # Do not echo an accidentally supplied --password value into logs.
        self.print_usage(sys.stderr)
        self.exit(2, "Invalid command options. Use --help. Passwords are accepted only through the hidden prompt.\n")


def _hidden(prompt):
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            return getpass.getpass(prompt)
    except getpass.GetPassWarning as error:
        raise ConfigurationError("A secure hidden password prompt is unavailable. Run this command in an interactive terminal.") from error


def _new_password():
    first = _hidden("New owner passphrase: ")
    second = _hidden("Confirm passphrase: ")
    if first != second:
        raise ConfigurationError("Passphrases do not match; nothing was changed.")
    return first


def main(argv=None):
    parser = _Parser(description="Local owner administration. No server, sessions or candidate changes.")
    commands = parser.add_subparsers(dest="command", required=True, parser_class=_Parser)
    for command in ("init", "verify-password", "reset-password", "recover-backup"):
        item = commands.add_parser(command)
        item.add_argument("--username", required=True)
        item.add_argument("--security-dir", "--config-dir", dest="security_dir", type=Path,
                          help="Absolute private owner directory; --config-dir is a compatibility alias. Default: current-user Local AppData/ApplicationTracker/security.")
    args = parser.parse_args(argv)
    try:
        username = normalize_username(args.username)
        repository = owner_repository(args.security_dir)
        if args.command == "init":
            repository.ensure_uninitialized()
            result = repository.initialize(username, _new_password())
            print(f"Owner created: {result.data['users'][0]['username']}. Private storage: {repository.directory}. No candidates were imported; sign in through the manager.")
        elif args.command == "verify-password":
            snapshot = repository.read()
            owner = repository._owner(snapshot.data, username)
            if owner["disabled"] or not verify_password(_hidden("Owner passphrase: "), owner["passwordVerifier"]):
                print("Password verification failed.", file=sys.stderr)
                return 1
            print("Password verified locally. No login session was created.")
        else:
            recovery = args.command == "recover-backup"
            snapshot = repository.recovery_snapshot() if recovery else repository.read()
            repository._owner(snapshot.data, username)
            action = "RECOVER" if recovery else "RESET"
            confirmation = input(f"Local administrative {action.lower()} for {username}. Type {action} {username} to continue: ")
            if confirmation != f"{action} {username}":
                raise ConfigurationError("Confirmation did not match; nothing was changed.")
            password = _new_password()
            if recovery:
                repository.recover_backup(username, password, expected_revision=snapshot.revision,
                                          expected_backup_revision=snapshot.backup_revision)
            else:
                repository.reset_password(username, password, expected_revision=snapshot.revision)
            print("Owner credentials updated; authentication epoch/generation rotated. Identity was preserved. Existing sessions will fail their next verification.")
        return 0
    except (ConfigurationError, OSError) as error:
        print(f"Owner operation refused: {error}", file=sys.stderr)
        return 1
    except (EOFError, KeyboardInterrupt):
        print("Owner operation cancelled; no credential update completed.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
