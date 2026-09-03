// 0.7.0 前端工单 A+B:技能双审批卡 + WRITE 技能预览分支 + 展示助手的静态标记断言。
// 交互(单选/按钮可用性/行内确认)由真实浏览器自检覆盖;这里锁契约字段到 UI 的映射不漂移。
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SkillCandidateApprovalCard } from '../../../src/renderer/features/approvals/SkillCandidateApprovalCard'
import { SkillInstallApprovalCard } from '../../../src/renderer/features/approvals/SkillInstallApprovalCard'
import { ApprovalCard } from '../../../src/renderer/features/approvals/ApprovalCard'
import {
  candidateMetaLine,
  formatCount,
  humanizeSkillLocation,
  registryLabel,
  skillNameFromSamplePaths,
} from '../../../src/renderer/features/approvals/skill-display'
import type { ApprovalCardState } from '../../../src/renderer/app/use-app-controller'
import type { FileApprovalRequest } from '../../../src/shared/domain'
import {
  demoSkillCandidateApproval,
  demoSkillInstallApproval,
  demoSkillInstallApprovalLong,
  DEMO_SKILL_MARKET_CANDIDATES_8,
  DEMO_SKILL_MARKET_CANDIDATE,
} from '../../helpers/mock-bridge'

const noop = () => {}

function pendingCard(request: ApprovalCardState['request']): ApprovalCardState {
  return {
    sessionId: 'demo-session-1',
    surfaceSessionId: 'demo-session-1',
    request,
    phase: 'pending',
    responded: false,
  }
}

describe('skill-display 展示助手', () => {
  it('registryLabel:curated→内置精选,github→GitHub', () => {
    expect(registryLabel('curated')).toBe('内置精选')
    expect(registryLabel('github')).toBe('GitHub')
  })

  it('formatCount:千分位且与环境无关', () => {
    expect(formatCount(1280)).toBe('1,280')
    expect(formatCount(12304)).toBe('12,304')
    expect(formatCount(8)).toBe('8')
  })

  it('humanizeSkillLocation:受控 URI 译成人话,不认识的形态返回 null 不露 URI 原文', () => {
    expect(humanizeSkillLocation('daweige-skill://global/files-and-photos-organize/SKILL.md')).toBe(
      '全局技能 / files-and-photos-organize',
    )
    expect(humanizeSkillLocation('daweige-skill://role/agent-a1b2c3d4e5f6/weekly-menu/SKILL.md')).toBe(
      '角色技能 / weekly-menu',
    )
    expect(humanizeSkillLocation('C:\\Users\\demo\\SKILL.md')).toBeNull()
    expect(humanizeSkillLocation('daweige-skill://global/../escape')).toBeNull()
  })

  it('skillNameFromSamplePaths:从示例路径里认全局技能 URI,认不出返回 null', () => {
    expect(skillNameFromSamplePaths(['daweige-skill://global/my-skill/SKILL.md'])).toBe('my-skill')
    expect(skillNameFromSamplePaths(['C:\\Users\\demo\\a.md'])).toBeNull()
    expect(skillNameFromSamplePaths([])).toBeNull()
  })

  it('candidateMetaLine:齐全字段全列,缺字段省略,全缺为空', () => {
    expect(candidateMetaLine(DEMO_SKILL_MARKET_CANDIDATE)).toBe(
      '作者 daweige · 1,280 次安装 · 版本 1.0.0 · 许可 MIT',
    )
    const sparse = DEMO_SKILL_MARKET_CANDIDATES_8.find((c) => c.optionId === 'opt_demo_06')
    expect(sparse).toBeDefined()
    expect(candidateMetaLine(sparse!)).toBe('作者 daweige · 96 次安装')
    expect(candidateMetaLine({ ...DEMO_SKILL_MARKET_CANDIDATE, owner: undefined, installs: undefined, version: undefined, license: undefined })).toBe('')
  })
})

describe('SkillCandidateApprovalCard(A1)', () => {
  it('渲染标题/搜索词/8 个候选,来源徽标与缺字段省略', () => {
    const html = renderToStaticMarkup(
      createElement(SkillCandidateApprovalCard, {
        card: pendingCard(demoSkillCandidateApproval(Date.now(), DEMO_SKILL_MARKET_CANDIDATES_8)),
        onRespond: noop,
      }),
    )
    expect(html).toContain('找到 8 个可用技能')
    expect(html).toContain('搜索词:file organize')
    expect(html).toContain('文件与照片整理')
    expect(html).toContain('super-long-english-slug-for-visual-overflow-testing-purposes-only')
    expect(html).toContain('内置精选')
    expect(html).toContain('GitHub')
    expect(html).toContain('2,457 星标')
    // opt_demo_06 缺 version/license:该行不出「许可」字样
    expect(html).not.toContain('许可 undefined')
    // 8 条 radio 齐备
    expect(html.match(/type="radio"/g)).toHaveLength(8)
  })

  it('无默认选中,「选这个」初始禁用;无「本次会话全部允许」', () => {
    const html = renderToStaticMarkup(
      createElement(SkillCandidateApprovalCard, {
        card: pendingCard(demoSkillCandidateApproval(Date.now(), DEMO_SKILL_MARKET_CANDIDATES_8)),
        onRespond: noop,
      }),
    )
    expect(html).not.toContain('checked')
    expect(html).toMatch(/<button[^>]*disabled[^>]*>选这个<\/button>/)
    expect(html).toContain('都不合适')
    expect(html).not.toContain('本次会话全部允许')
    expect(html).not.toContain('approve-session')
  })
})

describe('SkillInstallApprovalCard(A2)', () => {
  it('来源/许可/目标逻辑位置人话化 + 字节数,双键无会话授权', () => {
    const html = renderToStaticMarkup(
      createElement(SkillInstallApprovalCard, {
        card: pendingCard(demoSkillInstallApproval()),
        onRespond: noop,
      }),
    )
    expect(html).toContain('准备安装“文件与照片整理”')
    expect(html).toContain('装到:全局技能 / files-and-photos-organize')
    expect(html).not.toContain('daweige-skill://')
    expect(html).toContain('许可 MIT')
    expect(html).toContain('正文共 67 字节,全文如下')
    expect(html).toContain('# 文件与照片整理')
    expect(html).toContain('装它')
    expect(html).toContain('先别装')
    expect(html).not.toContain('本次会话全部允许')
  })

  it('截断态:头尾展示 + 中间明确截断标记', () => {
    const html = renderToStaticMarkup(
      createElement(SkillInstallApprovalCard, {
        card: pendingCard(demoSkillInstallApprovalLong()),
        onRespond: noop,
      }),
    )
    expect(html).toContain('中间内容已省略')
    expect(html).toContain('以下只展示开头和结尾')
    // 头(开头说明)与尾(验收)都在
    expect(html).toContain('先查看目录')
    expect(html).toContain('每张图片都有归属文件夹')
  })
})

describe('ApprovalCard WRITE 技能预览分支(B1)', () => {
  const skillWriteRequest: FileApprovalRequest = {
    id: 'approval-skill-write-demo',
    kind: 'write',
    title: '要把新技能「随手记模板」写进全局技能吗?',
    description: '我会新建一个全局技能,内容是纯文字说明,新建对话后生效。',
    itemCount: 1,
    samplePaths: ['daweige-skill://global/quick-note-template/SKILL.md'],
    recoverable: false,
    outsideWorkspace: false,
    toolCallId: 'tool-write-skill-demo',
    toolName: 'write_file',
    createdAt: Date.now(),
    contentPreview: '# 随手记模板\n\n先问记什么,再落一条笔记。',
  }

  it('带 contentPreview:三标识 + 等宽预览 + 无「本次会话全部允许」', () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalCard, { card: pendingCard(skillWriteRequest), onRespond: noop }),
    )
    expect(html).toContain('全局技能 / quick-note-template')
    expect(html).toContain('纯 Markdown')
    expect(html).toContain('新对话生效')
    expect(html).toContain('# 随手记模板')
    expect(html).not.toContain('本次会话全部允许')
    expect(html).not.toContain('daweige-skill://')
  })

  it('普通文件 WRITE 零回退:无标识行,会话授权按钮照旧出现', () => {
    const plainWrite: FileApprovalRequest = {
      id: 'approval-plain-write-demo',
      kind: 'write',
      title: '要写入汇总结果.md 吗?',
      description: '在稿件文件夹里新建一个文件。',
      itemCount: 1,
      samplePaths: ['C:\\Users\\demo\\Documents\\稿件\\汇总结果.md'],
      recoverable: false,
      outsideWorkspace: false,
      toolCallId: 'tool-write-plain-demo',
      toolName: 'write_file',
      createdAt: Date.now(),
    }
    const html = renderToStaticMarkup(
      createElement(ApprovalCard, { card: pendingCard(plainWrite), onRespond: noop }),
    )
    expect(html).not.toContain('纯 Markdown')
    expect(html).not.toContain('新对话生效')
    expect(html).not.toContain('全局技能 /')
    expect(html).toContain('本次会话全部允许')
    expect(html).toContain('写进去')
  })
})
