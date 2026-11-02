// 안드로이드 앱 빌드: android/ 의 Gradle 을 돌리고 결과(APK/AAB)를 release/android/ 로 모은다.
// 먼저 웹 화면을 빌드해 두어야 한다 (npm run android:apk 가 함께 한다).
// 필요: JDK 17 이상, Android SDK (ANDROID_HOME 또는 android/local.properties 의 sdk.dir)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const androidDir = path.join(root, 'android');
const tasks = process.argv.slice(2);
if (!tasks.length) tasks.push('assembleDebug');

if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) {
  console.error('dist/index.html 이 없습니다. 먼저 npm run build:web 을 실행하세요.');
  process.exit(1);
}
const hasSdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || fs.existsSync(path.join(androidDir, 'local.properties'));
if (!hasSdk) {
  console.error('Android SDK 를 찾지 못했습니다. ANDROID_HOME 을 정하거나 android/local.properties 에 sdk.dir=<경로> 를 적으세요.');
  process.exit(1);
}

const win = process.platform === 'win32';
const gradlew = path.join(androidDir, win ? 'gradlew.bat' : 'gradlew');
const r = spawnSync(gradlew, [...tasks, '--no-daemon'], { cwd: androidDir, stdio: 'inherit', shell: win });
if (r.status !== 0) process.exit(r.status ?? 1);

const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const outDir = path.join(root, 'release', 'android');
fs.mkdirSync(outDir, { recursive: true });
const outputs = path.join(androidDir, 'app', 'build', 'outputs');
const copied = [];
const walk = (dir) => {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(apk|aab)$/.test(e.name)) {
      // app-debug.apk → Kite-1.0.4-debug.apk
      const kind = e.name.replace(/^app-?/, '').replace(/\.(apk|aab)$/, '') || 'release';
      const dest = path.join(outDir, `Kite-${version}-${kind}.${e.name.split('.').pop()}`);
      fs.copyFileSync(p, dest);
      copied.push(path.relative(root, dest));
    }
  }
};
walk(outputs);
console.log(copied.length ? '만든 파일:\n  ' + copied.join('\n  ') : '만든 APK/AAB 가 없습니다.');
