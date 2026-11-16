import os from 'node:os';
import path from 'node:path';
// 시험용 저장 폴더는 늘 시스템 임시 폴더에 둔다 (TEMP 가 없는 운영체제에서 저장소 안에 폴더를 만들지 않게)
export const app = { getPath: () => path.join(os.tmpdir(), 'kite-ai-test') };
export const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('enc:' + s), decryptString: (b) => b.toString().slice(4) };
