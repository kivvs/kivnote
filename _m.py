import subprocess, time, os, sys, re

BASE = r'C:\Users\Lenovo\WorkBuddy\2026-10-21-14-15-36\app'
ELECTRON = os.path.join(BASE, 'node_modules', 'electron', 'dist', 'electron.exe')
PROC = 'electron.exe'


def kill_all():
    subprocess.run(['taskkill', '/IM', PROC, '/F'], capture_output=True)
    time.sleep(3)


def mem_rows():
    r = subprocess.run(['tasklist', '/FI', 'IMAGENAME eq ' + PROC, '/FO', 'CSV'],
                       capture_output=True, text=True, encoding='gbk', errors='ignore')
    rows = []
    for line in r.stdout.splitlines():
        m = re.match(r'"([^"]+)","(\d+)","[^"]+","\d+","([\d,.]+) K"', line)
        if m:
            rows.append(int(m.group(3).replace(',', '')))
    return rows


open_path = sys.argv[1] if len(sys.argv) > 1 else None
label = sys.argv[2] if len(sys.argv) > 2 else 'baseline'

kill_all()
env = dict(os.environ)
env.pop('ELECTRON_RUN_AS_NODE', None)
args = [ELECTRON, '.', '--no-sandbox', '--in-process-gpu']
if open_path:
    args.append('--open=' + open_path)

p = subprocess.Popen(args, env=env, cwd=BASE)
time.sleep(12)
rows = mem_rows()
print('%-20s 进程=%d  总=%5.0f MB   各进程=%s' % (
    label, len(rows), sum(rows) / 1024,
    ' '.join('%.0f' % (m / 1024) for m in rows)))
kill_all()
