import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionRepository } from '../../src/main/storage/session-repository'
import { RoleRepository } from '../../src/main/roles/role-repository'
import { canonicalWorkspaceKey } from '../../src/main/roles/role-files'

/**
 * A-24 角色默认模型 E2E(⑦审补:PLAN §2.3 建议的真实 Electron 链路)——
 * 直写 settings.json + 角色库(小柊入口+账房),验证:
 * 账房配了角色默认(glm)→ 开它的会话右下角显示 glm;
 * 小柊未配 → 默认入口会话显示全局默认(kimi)。
 * 不发消息(不依赖凭据),断言停留在三层解析的显示层。
 */

const WORKER_ROLE_ID = 'agent-a1b2c3d4e5f6'

async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, DAWEIGE_USER_DATA: userDataDir },
  })
  const win = await app.firstWindow()
  await win.waitForTimeout(2500)
  return { app, win }
}

test('A-24:账房默认 glm、小柊跟随全局——两会话右下角各显其主', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'role-models-e2e-'))
  const workspace = join(userDataDir, '账房工作区')
  await mkdir(workspace, { recursive: true })
  await mkdir(join(userDataDir, 'daweige', 'agents'), { recursive: true })
  await mkdir(join(userDataDir, 'daweige', 'system'), { recursive: true })

  // 小柊入口(真实 pi 会话)+ 账房(worker,挂在 WORKER_ROLE_ID 上与 roleModelDefaults 对齐)
  const sessionRepo = new SessionRepository(join(userDataDir, 'data', 'sessions.sqlite'))
  await sessionRepo.init()
  const mgrSession = await sessionRepo.create({
    cwd: join(userDataDir, 'system-manager-workspace'),
    providerId: 'kimi-coding',
    modelId: 'kimi-for-coding',
  })
  const mgrMeta = await mgrSession.getMetadata()
  await sessionRepo.close()
  const roleRepo = new RoleRepository(join(userDataDir, 'data', 'roles.sqlite'))
  await roleRepo.insertRole({
    role: {
      id: 'sys-xiaozhen', kind: 'manager', displayName: '小柊', templateId: 'manager-built-in',
      homeRelPath: 'daweige/system/sys-xiaozhen', guardrailsRelPath: 'manager-prompt.md',
      createdAt: 1, updatedAt: 1,
    },
    mounts: [],
    bindings: [{
      sessionId: mgrMeta.id, workspacePathSnapshot: userDataDir, archivedAt: null,
      visibility: 'user', source: 'created', boundAt: 1,
    }],
  })
  await roleRepo.insertRole({
    role: {
      id: WORKER_ROLE_ID, kind: 'worker', displayName: '账房', templateId: 'accountant',
      homeRelPath: `daweige/agents/${WORKER_ROLE_ID}`, guardrailsRelPath: 'guardrails.md',
      createdAt: 2, updatedAt: 2,
    },
    mounts: [{
      workspacePath: workspace, canonicalKey: await canonicalWorkspaceKey(workspace),
      ordinal: 0, isPrimary: true, availability: 'available',
    }],
  })
  await roleRepo.drainAndClose()

  // settings 直写:全局默认 kimi,池含 kimi+glm,账房默认 glm
  await writeFile(
    join(userDataDir, 'settings.json'),
    JSON.stringify({
      providerSelection: { providerId: 'kimi-coding', modelId: 'kimi-for-coding' },
      enabledModels: [
        { providerId: 'kimi-coding', modelId: 'kimi-for-coding' },
        { providerId: 'zai', modelId: 'glm-4.7' },
      ],
      roleModelDefaults: {
        [WORKER_ROLE_ID]: { providerId: 'zai', modelId: 'glm-4.7' },
      },
    }),
    'utf-8',
  )

  const { app, win } = await launchApp(userDataDir)
  try {
    // 断言①:默认入口是小柊会话,未配角色默认 → 右下角显示全局默认
    await expect(win.locator('.model-switch-model')).toHaveText('kimi-for-coding')

    // 点开账房 → 和他聊聊(走 session:create,主进程按 roleId 解析角色默认)
    const card = win.locator('.role-card', { hasText: '账房' })
    await expect(card).toBeVisible()
    await card.locator('.role-card-head').click()
    await win.waitForTimeout(800)
    await card.getByRole('button', { name: '和他聊聊' }).click()
    await win.waitForTimeout(1200)

    // 断言②:账房会话右下角显示角色默认 glm-4.7
    await expect(win.locator('.model-switch-model')).toHaveText('glm-4.7')
  } finally {
    await app.close().catch(() => {})
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
  }
})
