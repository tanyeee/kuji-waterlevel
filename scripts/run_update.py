from __future__ import annotations

import subprocess
import sys

steps = [
    [sys.executable, 'scripts/update_recent_from_monthly_page.py'],
    [sys.executable, 'scripts/merge_recent_into_historical.py'],
    [sys.executable, 'scripts/update_recent_10min_from_kawabou.py'],
]

for step in steps:
    print('running:', ' '.join(step))
    subprocess.run(step, check=True)
