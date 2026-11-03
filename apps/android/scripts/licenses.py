#!/usr/bin/env python3
"""Regenerate notices from pnpm's production install and the committed Gradle runtime report.
Uses only published POM metadata, artefact notices and licence URLs. Missing notices fail closed.
"""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import io
import json
import os
import re
import subprocess
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

APP = Path(__file__).resolve().parents[1]
DEST = APP / 'licenses'
CACHE = APP.parents[1] / '.local' / 'licence-inputs'
CACHE.mkdir(parents=True, exist_ok=True)

def fetch(url):
    key = __import__('hashlib').sha256(url.encode()).hexdigest()
    path = CACHE / key
    if path.exists(): return path.read_bytes()
    try:
        with urllib.request.urlopen(url, timeout=45) as answer: value = answer.read()
    except Exception: return None
    path.write_bytes(value)
    return value

def repository_url(value):
    value = value.removeprefix('git+').replace('ssh://git@github.com/', 'https://github.com/').replace('git@github.com:', 'https://github.com/').removesuffix('.git')
    if '://' not in value: value = 'https://github.com/' + value.removeprefix('github:')
    return value

def notices(folder):
    return '\n\n'.join(path.read_text(errors='replace') for path in sorted(folder.rglob("*"))
                       if path.is_file() and re.match(r'^(licen[cs]e|notice|copying|copyright)([.\-_]|$)', path.name, re.I))

# Metro's release source map identifies shipped JS; CLI/build-only packages are not in the app.
bundle = CACHE / 'bundle'
subprocess.run(['pnpm', 'exec', 'expo', 'export', '--platform', 'android', '--source-maps', '--output-dir', str(bundle)], cwd=APP, env={**os.environ, 'CI': '1'}, check=True, stdout=subprocess.DEVNULL)
runtime = set()
for source_map in bundle.rglob('*.map'):
    for source in json.loads(source_map.read_text()).get('sources', []):
        match = re.search(r'node_modules/(?:\.pnpm/[^/]+/node_modules/)?(@[^/]+/[^/]+|[^/]+)', source)
        if not match: continue
        relative = source[match.start():match.end()]
        package_json = APP / relative / 'package.json'
        if not package_json.exists(): raise RuntimeError(f'Unresolved bundle package: {relative}')
        metadata = json.loads(package_json.read_text())
        runtime.add((metadata['name'], metadata['version']))

def autolink(command):
    output = subprocess.check_output(['pnpm', 'exec', 'expo-modules-autolinking', command, '--platform', 'android', '--json'], cwd=APP).decode()
    return json.loads(output[output.index('{'):])

expo_modules = autolink('resolve')['modules']
rn_modules = autolink('react-native-config')['dependencies']
for module in expo_modules:
    runtime.add((module['packageName'], module['packageVersion']))
for module in rn_modules.values():
    metadata = json.loads((Path(module['root']) / 'package.json').read_text())
    runtime.add((metadata['name'], metadata['version']))
js = json.loads(subprocess.check_output(['pnpm', 'licenses', 'list', '--prod', '--json'], cwd=APP))
known = {package['name'] for packages in js.values() for package in packages}
for module in expo_modules:
    if module['packageName'] in known or module['packageName'] == 'credentials': continue
    folder = Path(module['projects'][0]['sourceDir']).parent
    metadata = json.loads((folder / 'package.json').read_text())
    js.setdefault(metadata['license'], []).append(dict(name=metadata['name'], paths=[str(folder)]))
components = []
local_repositories = {}
notice_sources = json.loads((DEST / 'notice-sources.json').read_text())
for licence, packages in js.items():
    for package in packages:
        for folder in package['paths']:
            local = Path(folder) / 'local-maven-repo'
            if local.is_dir(): local_repositories[local.as_uri() + '/'] = f"https://www.npmjs.com/package/{package['name']}"
        for folder in package['paths']:
            folder = Path(folder)
            metadata = json.loads((folder / 'package.json').read_text())
            if (metadata['name'], metadata['version']) not in runtime: continue
            text = notices(folder)
            if not text:
                text = '\n\n'.join(p.read_text(errors='replace') for p in sorted(folder.rglob('*')) if p.is_file() and re.search(r'(^|[.\-_])(licen[cs]e|notice)([.\-_]|$)', p.name, re.I))
            repository = metadata.get('repository', '')
            if isinstance(repository, dict): repository = repository.get('url', '')
            if not repository:
                bugs = metadata.get('bugs', {})
                if isinstance(bugs, dict): repository = bugs.get('url', '').removesuffix('/issues')
            if not text:
                for code in sorted(folder.glob('*.js')):
                    content = code.read_text(errors='replace')
                    comment = re.search(r'/\*([\s\S]*?)\*/', content)
                    if comment and 'Permission is hereby granted' in comment[1]:
                        text = comment[1].strip()
                        break
            if not text and repository:
                repo = repository if '://' in repository else 'https://github.com/' + repository
                repo = repo.removeprefix('git+').replace('ssh://git@github.com/', 'https://github.com/').removesuffix('.git')
                if repo.startswith('https://github.com/'):
                    location = repo.removeprefix('https://github.com/')
                    published = fetch(f"https://registry.npmjs.org/{package['name']}/{metadata['version']}")
                    head = json.loads(published).get('gitHead') if published else None
                    tags = [head, f"{package['name']}@{metadata['version']}", f"v{metadata['version']}", metadata['version']]
                    for tag in filter(None, tags):
                        for filename in ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md', 'LICENCE', 'LICENSE-MIT', 'README.md']:
                            value = fetch(f'https://raw.githubusercontent.com/{location}/{tag}/{filename}')
                            if value:
                                candidate = value.decode('utf8', errors='replace')
                                if filename == 'README.md' and 'Permission is hereby granted' not in candidate: continue
                                text = candidate
                                break
                        if text: break
            notice_source = notice_sources.get(f"{package['name']}@{metadata['version']}")
            if not text and notice_source:
                value = fetch(notice_source)
                if value: text = value.decode('utf8', errors='replace')
            if not text: raise RuntimeError(f"No JS notice: {package['name']}")
            components.append(dict(name=package['name'], version=metadata['version'], licence=licence,
                                   source=(repository_url(repository) if repository else '') or package.get('homepage') or f"https://www.npmjs.com/package/{package['name']}", notice=text))

coordinates = set()
for line in (DEST / 'releaseRuntimeClasspath.txt').read_text().splitlines():
    if '(c)' in line: continue
    match = re.search(r'--- ([\w.-]+):([\w.-]+):([^\s]+)(?: -> ([^\s]+))?', line)
    if not match: continue
    group, name, version, resolved = match.groups()
    if resolved:
        if ':' in resolved: group, name, version = resolved.split(':')
        else: version = resolved
    coordinates.add((group, name, version))

NS = {'m': 'http://maven.apache.org/POM/4.0.0'}
def parse_pom(raw):
    root = ET.fromstring(raw)
    for node in root.iter():
        if not node.tag.startswith('{'): node.tag = '{' + NS['m'] + '}' + node.tag
    return root

def native(coordinate):
    group, name, version = coordinate
    relative = f"{group.replace('.', '/')}/{name}/{version}/{name}-{version}"
    bases = [*local_repositories, 'https://dl.google.com/dl/android/maven2/', 'https://repo.maven.apache.org/maven2/']
    raw = None
    for base in bases:
        raw = fetch(base + relative + '.pom')
        if raw: break
    if not raw: raise RuntimeError(f'POM unavailable: {coordinate}')
    pom = parse_pom(raw)
    licences = pom.findall('m:licenses/m:license', NS)
    ancestor = pom
    for _ in range(10):
        if licences: break
        parent = ancestor.find('m:parent', NS)
        if parent is None: break
        pg, pn, pv = (parent.findtext('m:' + field, '', NS) for field in ['groupId', 'artifactId', 'version'])
        parent_path = f"{pg.replace('.', '/')}/{pn}/{pv}/{pn}-{pv}.pom"
        parent_bytes = fetch(base + parent_path)
        if not parent_bytes: break
        ancestor = parse_pom(parent_bytes)
        licences = ancestor.findall('m:licenses/m:license', NS)
    texts = []
    attributions = []
    for suffix in ['.jar', '.aar', '-sources.jar']:
        data = fetch(base + relative + suffix)
        if not data: continue
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                for entry in sorted(archive.namelist()):
                    if re.search(r'(^|/)(licen[cs]e|notice|copying|copyright)([.\-_]|$)', entry, re.I) and not entry.endswith('/'):
                        texts.append(archive.read(entry).decode('utf8', errors='replace'))
                    elif entry.endswith(('.java', '.kt', '.h', '.cpp', '.c')):
                        header = archive.read(entry)[:12000].decode('utf8', errors='replace')
                        comment = re.search(r'/\*([\s\S]*?)\*/', header)
                        if comment and re.search('copyright', comment[1], re.I): attributions.append(comment[0])
        except zipfile.BadZipFile: pass
    if not texts:
        repository = (pom.findtext('m:scm/m:url', '', NS) or ancestor.findtext('m:scm/m:url', '', NS)).removesuffix('.git')
        if repository.startswith('https://github.com/'):
            location = repository.removeprefix('https://github.com/')
            for tag in [f'v{version}', version, f'{name}@{version}']:
                for filename in ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license']:
                    data = fetch(f'https://raw.githubusercontent.com/{location}/{tag}/{filename}')
                    if data:
                        texts.append(data.decode('utf8', errors='replace'))
                        break
                if texts: break
    if not texts:
        for licence in licences:
            url = licence.findtext('m:url', '', NS).replace('http:', 'https:')
            if url.startswith('https://github.com/') and '/blob/' in url:
                url = url.replace('https://github.com/', 'https://raw.githubusercontent.com/').replace('/blob/', '/')
            if 'opensource.org' in url and 'mit' in url.lower(): url = 'https://spdx.org/licenses/MIT.txt'
            data = fetch(url) if url else None
            if data:
                text = data.decode('utf8', errors='replace')
                # HTML is not a notice. Apache publishes the full plain text alongside the page.
                if '<html' in text.lower() or '<!doctype' in text.lower():
                    if 'apache.org/licenses/LICENSE-2.0' in url:
                        text = fetch('https://www.apache.org/licenses/LICENSE-2.0.txt').decode()
                    elif 'opensource.org' in url and 'mit' in url.lower():
                        text = fetch('https://spdx.org/licenses/MIT.txt').decode()
                    else: continue
                texts.append(text)
    if not texts: raise RuntimeError(f'Full notice unavailable: {coordinate}')
    return dict(name=f'{group}:{name}', version=version,
                licence=' AND '.join(x.findtext('m:name', '', NS) for x in licences) or 'See notice',
                source=local_repositories.get(base, base + relative + '.pom'), notice='\n\n'.join(dict.fromkeys([*texts, *attributions])))

with ThreadPoolExecutor(max_workers=12) as pool:
    components.extend(pool.map(native, sorted(coordinates)))
# The app and its portable workspace packages are built from this repository under GPL-3.0.
root = APP.parents[1]
app_version = json.loads((APP / 'app.json').read_text())['expo']['version']
for folder in [APP, root / 'packages/contracts', root / 'packages/core', root / 'packages/mobile']:
    metadata = json.loads((folder / 'package.json').read_text())
    components.append(dict(name=metadata['name'], version=app_version, licence=metadata['license'],
                           source='https://git.cafe/mr-streamer-oss/mrstreamer', notice=(root / 'LICENSE').read_text()))
unique = {(item['name'], item['version']): item for item in components}
manifest = sorted(unique.values(), key=lambda item: (item['name'].lower(), item['version']))
(DEST / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
print(f"Wrote {len(manifest)} components")
