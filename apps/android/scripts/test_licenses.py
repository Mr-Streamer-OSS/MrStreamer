"""Fail-closed generator proof in a temporary checkout, with no network or app install."""
from pathlib import Path
import json
import shutil
import subprocess
import sys
import tempfile
import unittest


class LicencesFailure(unittest.TestCase):
    def test_missing_notice_preserves_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = root / 'apps' / 'android'
            scripts = app / 'scripts'
            dest = app / 'licenses'
            package = app / 'node_modules' / 'fixture'
            for folder in [scripts, dest, package]:
                folder.mkdir(parents=True)
            shutil.copyfile(Path(__file__).with_name('licenses.py'), scripts / 'licenses.py')
            (package / 'package.json').write_text(json.dumps({'name': 'fixture', 'version': '1.0.0', 'license': 'MIT'}))
            (package / 'index.js').write_text('export const fixture = true;')
            (app / 'app.json').write_text('{"expo":{"version":"1.0.0"}}')
            (app / 'pnpm-lock.yaml').write_text('      fixture:\n        specifier: 1.0.0\n        version: 1.0.0\n')
            (dest / 'notice-sources.json').write_text('{}')
            (dest / 'releaseRuntimeClasspath.txt').write_text('')
            outputs = ['bundle-sources.json', 'bundle-components.json', 'native-projects.json', 'manifest.json', 'summary.json']
            for name in outputs:
                (dest / name).write_bytes(b'previous output\n')
            mapping = root / 'map.json'
            mapping.write_text('{"sources":["node_modules/fixture/index.js"]}')
            # Only Expo discovery is replaced. The copied generator executes unchanged.
            runner = scripts / 'run.py'
            runner.write_text("import runpy, subprocess, sys\nsubprocess.check_output = lambda command, **kw: b'{\"modules\":[],\"dependencies\":{}}'\nsys.argv = ['licenses.py', sys.argv[1]]\nrunpy.run_path(__file__.replace('run.py', 'licenses.py'), run_name='__main__')\n")
            result = subprocess.run([sys.executable, str(runner), str(mapping)], capture_output=True, text=True, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('No JS notice: fixture', result.stderr)
            for name in outputs:
                self.assertEqual((dest / name).read_bytes(), b'previous output\n', name)


if __name__ == '__main__':
    unittest.main()
