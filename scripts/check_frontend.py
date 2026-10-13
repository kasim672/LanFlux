"""Small static checks for this native frontend; no external lint dependency."""

from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / 'lanflux' / 'static'


class Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = []
        self.anchors = []
        self.assets = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if 'id' in attributes:
            self.ids.append(attributes['id'])
        if tag == 'a' and attributes.get('href', '').startswith('#'):
            self.anchors.append(attributes['href'][1:])
        for key in ['src', 'href']:
            if attributes.get(key, '').startswith('/static/'):
                self.assets.append(attributes[key][1:])
        assert not any(key.startswith('on') or key == 'style' for key, _ in attrs), 'Inline code/style violates CSP'
        if tag == 'script':
            assert attributes.get('src'), 'Inline script violates CSP'


def main():
    page = Page()
    page.feed((STATIC / 'index.html').read_text())
    duplicates = [key for key, count in Counter(page.ids).items() if count > 1]
    assert not duplicates, f'Duplicate HTML IDs: {duplicates}'
    ids = set(page.ids)
    assert set(page.anchors) <= ids, f'Broken navigation: {set(page.anchors) - ids}'
    references = set()
    for path in STATIC.glob('*.js'):
        source = path.read_text()
        references.update(re.findall(r"(?:\$|document\.getElementById)\(['\"]([^'\"]+)['\"]\)", source))
        for module in re.findall(r"(?:from|import)\s*['\"](\.[^'\"]+)['\"]", source):
            assert (path.parent / module).is_file(), f'Missing module: {module}'
    assert references <= ids, f'Missing controls: {references - ids}'
    for asset in page.assets:
        assert (ROOT / 'lanflux' / asset).is_file(), f'Missing asset: {asset}'
    modules = sorted(STATIC.rglob('*.js')) + sorted((ROOT / 'tests').glob('*.mjs')) + sorted((ROOT / 'scripts').glob('*.mjs'))
    for module in modules:
        subprocess.run(['node', '--check', str(module)], check=True)
    print(f'Frontend checks passed: {len(ids)} unique IDs, navigation/assets/control references, CSP and {len(modules)} JS syntax checks.')


if __name__ == '__main__':
    main()
