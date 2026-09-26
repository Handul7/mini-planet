#!/usr/bin/env python3
"""Pull validated UI releases. Never installs backend code or reads credentials.

Default: verify only. --apply requires an explicitly installed local config.
The existing ownerctl is the sole process manager; Hermes is never restarted.
"""
import argparse
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

PUBLIC = {'index.html', 'src', 'assets', 'vendor', 'config', 'agent-status.json',
          'agent-results.json', 'manifest.json', 'robots.txt', 'sitemap.xml',
          'sw.js', 'favicon.ico', 'LICENSE'}
MAX_ARCHIVE = 32 * 1024 * 1024
MAX_EXTRACTED = 64 * 1024 * 1024


class UpdateError(ValueError):
    """A fixed diagnostic code safe to include in operational logs."""


def require(condition, message):
    if not condition:
        raise UpdateError(message)


def download(url, maximum):
    request = Request(url, headers={'User-Agent': 'mini-planet-owner-ui/1', 'Accept': 'application/vnd.github+json'})
    with urlopen(request, timeout=20) as response:
        final = urlsplit(response.url)
        require(final.scheme == 'https' and (final.hostname in {'github.com', 'api.github.com'}
                or final.hostname.endswith('.githubusercontent.com')), 'unexpected_download_host')
        result = response.read(maximum + 1)
    require(len(result) <= maximum, 'download_too_large')
    return result


def latest_release(repo):
    releases = json.loads(download(f'https://api.github.com/repos/{repo}/releases?per_page=30', 2 * 1024 * 1024))
    require(isinstance(releases, list), 'invalid_release_list')
    for release in releases:
        tag = release.get('tag_name', '')
        assets = {item.get('name') for item in release.get('assets', [])}
        if release.get('draft') is False and release.get('prerelease') is True and re.fullmatch(r'owner-ui-[a-f0-9]{40}', tag) and {
            'owner-ui.tar.gz', 'owner-ui.manifest.json'
        }.issubset(assets):
            return tag[9:]
    raise ValueError('no_validated_ui_release')


def validate_manifest(value, commit):
    require(isinstance(value, dict) and type(value.get('schemaVersion')) is int and value.get('schemaVersion') == 1
            and type(value.get('apiContract')) is int and value.get('apiContract') == 1 and value.get('commit') == commit
            and re.fullmatch(r'[a-f0-9]{64}', value.get('sha256', '')) is not None,
            'incompatible_release_manifest')
    return value


def extract_ui(archive, destination, expected_commit=None):
    """Manual extraction: no links, traversal, scripts, local overrides or devices."""
    seen, roots, total = set(), set(), 0
    with tarfile.open(archive, 'r:gz') as bundle:
        for number, member in enumerate(bundle):
            require(number < 4000, 'too_many_archive_entries')
            name = member.name.removeprefix('./').rstrip('/')
            if name in {'', '.'} and member.isdir():
                continue
            path = PurePosixPath(name)
            require(not path.is_absolute() and all(part not in {'', '..', '.'} and not part.startswith('.')
                    for part in path.parts) and '\\' not in name, 'unsafe_archive_path')
            require(path.parts[0] in PUBLIC and path.name != 'services.local.json'
                    and not path.name.endswith(('.local.json', '.map')), 'private_archive_entry')
            require(member.isfile() or member.isdir(), 'unsupported_archive_entry')
            require(name not in seen, 'duplicate_archive_entry')
            seen.add(name); roots.add(path.parts[0])
            target = destination.joinpath(*path.parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            total += member.size
            require(0 <= member.size <= MAX_ARCHIVE and total <= MAX_EXTRACTED, 'extracted_size_limit')
            target.parent.mkdir(parents=True, exist_ok=True)
            with bundle.extractfile(member) as source, target.open('xb') as output:
                shutil.copyfileobj(source, output)
            target.chmod(0o644)
    require(roots == PUBLIC, 'incomplete_public_tree')
    for name in ['index.html', 'sw.js', 'src/main.js', 'src/owner-client.js', 'src/owner-workspace.js']:
        require((destination / name).is_file(), 'missing_required_ui')
    if expected_commit is not None:
        stamp = destination / 'src/owner-release.json'
        require(stamp.is_file() and stamp.stat().st_size <= 4096, 'missing_release_identity')
        identity = json.loads(stamp.read_text())
        require(isinstance(identity, dict) and identity.get('commit') == expected_commit
                and type(identity.get('apiContract')) is int and identity['apiContract'] == 1,
                'release_identity_mismatch')


def load_config(path):
    details = path.stat()
    require(not path.is_symlink() and details.st_uid == os.getuid() and details.st_mode & 0o077 == 0,
            'config_must_be_owned_and_private')
    config = json.loads(path.read_text())
    require(re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', config.get('repo', '')) is not None, 'invalid_repository')
    for name in ['siteRoot', 'ownerctl', 'python', 'stateDir']:
        value = Path(config[name])
        # venv/bin/python is normally a symlink. Preserve its invocation path,
        # which selects the venv; filesystem mutation targets remain canonical.
        require(value.is_absolute() and (name == 'python' or value.resolve() == value), f'invalid_{name}')
        config[name] = value
    root = config['siteRoot']
    require(root.name == '_site' and root.is_dir() and (root / 'index.html').is_file(), 'invalid_site_root')
    require(config['ownerctl'].is_file() and config['python'].is_file(), 'missing_owner_manager')
    require(root not in config['stateDir'].parents and config['stateDir'] != root, 'state_inside_public_site')
    port = config.get('ownerPort', 8787)
    require(type(port) is int and 1 <= port <= 65535, 'invalid_owner_port')
    origin = config.get('publicOrigin')
    if origin:
        parsed = urlsplit(origin)
        require(parsed.scheme == 'https' and parsed.hostname and not parsed.username and not parsed.password
                and parsed.path == '' and not parsed.query and not parsed.fragment, 'invalid_public_origin')
    return config


def manage(config, action):
    # The installed helper validates process identity and resolves controller port.
    # Never log its potentially sensitive runtime output.
    subprocess.run([str(config['python']), str(config['ownerctl']), action], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=40)


def site_fingerprints(root):
    paths = ['index.html', 'src/main.js', 'sw.js', 'src/owner-release.json']
    return {'/' + name: hashlib.sha256((root / name).read_bytes()).hexdigest()
            for name in paths if (root / name).is_file()}


def healthy(config, fingerprints):
    port = config.get('ownerPort', 8787)
    host = urlsplit(config['publicOrigin']).netloc if config.get('publicOrigin') else f'127.0.0.1:{port}'
    for _ in range(10):
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
        try:
            matches = bool(fingerprints)
            for path, expected in fingerprints.items():
                connection.close()
                connection = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
                connection.request('GET', path, headers={'Host': host})
                response = connection.getresponse()
                body = response.read(MAX_ARCHIVE + 1)
                if response.status != 200 or hashlib.sha256(body).hexdigest() != expected:
                    matches = False
                    break
            if matches:
                connection.close()
                connection = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
                connection.request('GET', '/owner/session', headers={'Host': host})
                response = connection.getresponse()
                body = response.read(4097)
                if response.status == 401 and json.loads(body).get('authenticated') is False:
                    return True
        except (OSError, ValueError, http.client.HTTPException):
            pass
        finally:
            connection.close()
        time.sleep(1)
    return False


def write_json(path, value):
    temp = path.with_suffix('.tmp')
    with temp.open('w') as stream:
        json.dump(value, stream)
        stream.flush(); os.fsync(stream.fileno())
    os.replace(temp, path)


def activate(config, staged, commit, *, control=manage, check=healthy):
    root, state = config['siteRoot'], config['stateDir']
    journal = state / 'pending.json'
    require(not journal.exists(), 'unfinished_update_requires_recovery')
    backup = root.parent / f'.owner-ui-backup-{time.time_ns()}'
    old_digest = site_fingerprints(root)
    new_digest = site_fingerprints(staged)
    require(check(config, old_digest), 'existing_owner_healthcheck_failed')
    write_json(journal, {'commit': commit, 'backup': str(backup), 'siteRoot': str(root), 'stage': str(staged)})
    swapped = False
    moved_old = False
    try:
        control(config, 'stop')
        os.replace(root, backup); moved_old = True
        os.replace(staged, root); swapped = True
        control(config, 'start')
        require(check(config, new_digest), 'new_ui_healthcheck_failed')
        write_json(state / 'current.json', {'commit': commit, 'previousSite': str(backup)})
    except Exception as error:
        if moved_old:
            control(config, 'stop')
            if swapped:
                os.replace(root, staged)
            os.replace(backup, root)
            control(config, 'start')
            require(check(config, old_digest), 'rollback_healthcheck_failed_keep_pending_journal')
        else:
            # A stop may have succeeded before a helper timeout; restore service.
            control(config, 'start')
            require(check(config, old_digest), 'original_service_recovery_failed_keep_pending_journal')
        journal.unlink()
        error.quarantine_release = swapped
        raise
    # The successful current.json write commits the transition. A cleanup error
    # keeps the new UI and recovery journal; it must not roll back behind metadata.
    journal.unlink()


def run(config, apply=False):
    state = config['stateDir']
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    require(state.stat().st_uid == os.getuid() and state.stat().st_mode & 0o077 == 0, 'state_must_be_private')
    with (state / 'update.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        require(not (state / 'pending.json').exists(), 'unfinished_update_requires_recovery')
        commit = latest_release(config['repo'])
        current = state / 'current.json'
        if current.exists() and json.loads(current.read_text()).get('commit') == commit:
            print(f'UI already current: {commit[:12]}'); return
        failed = state / 'failed.json'
        if failed.exists() and json.loads(failed.read_text()).get('commit') == commit:
            raise ValueError('failed_release_quarantined_until_review')
        base = f'https://github.com/{config["repo"]}/releases/download/owner-ui-{commit}'
        manifest = validate_manifest(json.loads(download(base + '/owner-ui.manifest.json', 4096)), commit)
        archive = download(base + '/owner-ui.tar.gz', MAX_ARCHIVE)
        require(hashlib.sha256(archive).hexdigest() == manifest['sha256'], 'archive_checksum_mismatch')
        with tempfile.TemporaryDirectory(prefix='.owner-ui-stage-', dir=config['siteRoot'].parent) as temp:
            staging = Path(temp)
            tar = staging / 'ui.tar.gz'; tar.write_bytes(archive)
            site = staging / 'site'; site.mkdir()
            extract_ui(tar, site, expected_commit=commit)
            if apply:
                try:
                    activate(config, site, commit)
                except Exception as error:
                    if getattr(error, 'quarantine_release', False):
                        write_json(failed, {'commit': commit})
                    raise
            print(f'UI {"applied" if apply else "verified only"}: {commit[:12]}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    try:
        run(load_config(args.config), args.apply)
    except Exception as error:
        # No URLs, credentials, private paths or subprocess output in logs.
        reason = str(error) if isinstance(error, UpdateError) else type(error).__name__
        print(f'UI update stopped ({reason}). Existing backup/journal retained if recovery is needed.')
        raise SystemExit(1)
