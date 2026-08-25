import { safeStorage } from 'electron'

/**
 * safeStorage 抽象(M2-03)。
 * 注入式设计便于单测(fake DPAPI);生产实现走 Electron 推荐的异步 API。
 * decryptStringAsync 返回 { result, shouldReEncrypt }:密钥轮换时需重新加密写回。
 */

export interface DecryptedString {
  result: string
  shouldReEncrypt: boolean
}

export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Promise<Buffer>
  decryptString(encrypted: Buffer): Promise<DecryptedString>
}

export function createElectronSafeStorage(): SafeStorageAdapter {
  return {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (plain) => safeStorage.encryptStringAsync(plain),
    decryptString: async (encrypted) => {
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(encrypted)
      return { result, shouldReEncrypt }
    },
  }
}
