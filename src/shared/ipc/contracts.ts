import type {
  ApprovalResponse,
  ChatMessage,
  CredentialStatus,
  ManagerWorkspaceMigrateRequest,
  ManagerWorkspaceState,
  MemoryEntry,
  ProviderId,
  ProviderInfo,
  ProviderSelection,
  Reminder,
  RoleDeleteImpact,
  RoleDeleteResult,
  RoleDetail,
  RoleSummary,
  RoleTemplate,
  SessionDetail,
  SessionSummary,
  Settings,
  UsageDashboard,
} from '../domain'

/**
 * IPC 请求/响应契约——M1-03 冻结。
 * 每个通道必须且只能在这里声明一对 request/response 类型。
 *
 * 安全约束(测试强制):
 * - apiKey 只允许出现在 credential:save 的 request(用户提交);
 * - 所有 response 类型不得含 apiKey 字段。
 */

/** 应用启动一次性状态。 */
export interface BootstrapState {
  readonly appVersion: string
  /** 启动迁移失败时的中文说明(含"重启应用会重试"指引);正常为空。 */
  readonly migrationError?: string
  /** 总管种子(0.3.0);null=种子失败降级(前端显示可恢复警示,不伪造小柊)。 */
  readonly manager: import('../domain/manager').ManagerBootstrap | null
  /** 全部用户角色(含已归档;前端按 archivedAt 分组)。 */
  readonly roles: readonly RoleSummary[]
  /** 全部用户可见会话(含已归档;前端按 roleId 分组、按 archivedAt 过滤)。 */
  readonly sessions: readonly SessionSummary[]
  readonly settings: Settings
  readonly providers: readonly ProviderInfo[]
  readonly credentialStatuses: readonly CredentialStatus[]
  readonly upcomingReminders: readonly Reminder[]
}

/** 模型下拉选项(A-10):id 必有;规格来自本地表(在线接口不返回上下文长度)。 */
export interface ModelOption {
  readonly id: string
  /** 上下文窗口(token);本地规格表没有的模型为 undefined,前端显示"未知"。 */
  readonly contextWindow?: number
  readonly source: 'online' | 'catalog'
}

/** 连通测试结果。 */
export interface ConnectivityResult {
  readonly ok: boolean
  /** 中文结果说明:"连接正常,当前模型 kimi-for-coding" / "Key 无效,请检查后重填"。 */
  readonly message: string
}

/** 导入到工作文件夹的文件(重名自动改名后实际落盘的名字)。 */
export interface ImportedFile {
  readonly fileName: string
  readonly importedAs: string
}

export interface IpcRequestMap {
  'app:getBootstrapState': {
    request: void
    response: BootstrapState
  }
  'workspace:choose': {
    /** request 为 void;由主进程弹系统目录选择器。 */
    request: void
    /** 选中的绝对路径;用户取消返回 null。 */
    response: string | null
  }
  'role:listTemplates': {
    request: void
    response: readonly RoleTemplate[]
  }
  'role:list': {
    request: void
    response: readonly RoleSummary[]
  }
  'role:get': {
    request: {
      readonly roleId: string
    }
    response: RoleDetail
  }
  'role:create': {
    request: {
      /** trim 后 1~24 字。 */
      readonly displayName: string
      /** 1~8 个绝对路径(去重);0.2.0 UI 只提交一个。(TypeBox Static 产可变数组,故不标 readonly) */
      readonly workspacePaths: string[]
      /** 必须属于 workspacePaths;主挂载=新会话的 cwd。 */
      readonly primaryWorkspacePath: string
      /** 只允许四个用户模板;legacy-empty 由迁移生成,不接受外部创建。 */
      readonly templateId: 'writer' | 'accountant' | 'file-steward' | 'notebook'
      /** 0~6000 Unicode 字符;24KiB 字节上限由主进程二次校验。 */
      readonly guardrails: string
    }
    response: RoleDetail
  }
  'role:update': {
    request: {
      readonly roleId: string
      readonly displayName: string
    }
    response: RoleSummary
  }
  'role:updateGuardrails': {
    request: {
      readonly roleId: string
      readonly guardrails: string
      /** 乐观并发:必须等于当前 guardrailsVersion,否则拒绝。 */
      readonly expectedVersion: number
    }
    response: RoleDetail
  }
  'role:archive': {
    request: {
      readonly roleId: string
    }
    response: RoleSummary
  }
  'role:restore': {
    request: {
      readonly roleId: string
    }
    response: RoleSummary
  }
  'role:getDeleteImpact': {
    request: {
      readonly roleId: string
    }
    response: RoleDeleteImpact
  }
  'role:delete': {
    request: {
      readonly roleId: string
      /** 必须与角色当前显示名完全一致(用户输入确认)。 */
      readonly confirmDisplayName: string
      /** getDeleteImpact 返回的原值;数据变化即拒绝。 */
      readonly impactVersion: string
      /** 语义固定为 true(连同子会话与角色家目录一起删);schema 只接受字面 true。 */
      readonly deleteSessions: true
    }
    response: RoleDeleteResult
  }
  'session:list': {
    request: void
    response: readonly SessionSummary[]
  }
  'session:create': {
    request: {
      /** 会话挂在哪个角色下(worker roleId 或内置总管 'sys-xiaozhen');cwd 由主进程解析,不信任渲染进程传路径。 */
      readonly roleId: string
    }
    response: SessionDetail
  }
  'session:open': {
    request: {
      readonly sessionId: string
    }
    response: SessionDetail
  }
  'session:rename': {
    request: {
      readonly sessionId: string
      /** 1~60 字;超长/空白被 schema 拒。 */
      readonly title: string
    }
    response: SessionSummary
  }
  'session:delete': {
    request: {
      readonly sessionId: string
    }
    response: void
  }
  'session:archive': {
    request: {
      readonly sessionId: string
    }
    /** 归档后的最新会话摘要(archivedAt 非空)。 */
    response: SessionSummary
  }
  'session:restore': {
    request: {
      readonly sessionId: string
    }
    /** 恢复后的最新会话摘要(archivedAt 为 null)。 */
    response: SessionSummary
  }
  /** 派活列表(0.3.0):只返回该 manager 会话拥有的 run,按 createdAt 稳定排序。 */
  'agentRun:list': {
    request: {
      readonly managerSessionId: string
    }
    response: readonly import('../domain/manager').AgentRunSummary[]
  }
  /**
   * 派活详情(0.3.0):唯一 internal 会话读取入口,只读。
   * 先校验 run 存在与归属;不暴露任何 internal 写/删/abort 操作。
   */
  'agentRun:getDetail': {
    request: {
      readonly runId: import('../domain/manager').AgentRunId
      /** 调用方 manager 会话(ownership 双重校验;codex 阶段复审整改,对齐 getGraph/interrupt) */
      readonly managerSessionId: string
    }
    response: import('../domain/manager').AgentRunDetail
  }
  /**
   * 协作链整图(0.4.0 D):只返回该 manager 会话拥有的 graph;
   * 图状态完全由 DTO 推导(刷新校正用),renderer 不在本地存第二份。
   */
  'agentRun:getGraph': {
    request: {
      readonly graphId: import('../domain/manager').AgentGraphId
      readonly managerSessionId: string
    }
    response: import('../domain/manager').AgentRunGraph
  }
  /**
   * 受控打断(0.4.0 D):只允许当前用户可见 manager 会话拥有的非终态 run;
   * 重复请求幂等返回最新状态;不能传 internal sessionId。
   */
  'agentRun:interrupt': {
    request: {
      readonly runId: import('../domain/manager').AgentRunId
      readonly managerSessionId: string
    }
    response: import('../domain/manager').AgentRunSummary
  }
  'message:send': {
    request: {
      readonly sessionId: string
      /** 1~100000 字。 */
      readonly text: string
      /** 当前消息明确使用的模型；主进程仍须校验启用池与凭据。 */
      readonly selection: ProviderSelection
    }
    /** 持久化后的用户消息(带主进程生成的 id/createdAt);回复经 agent:event 流回。 */
    response: ChatMessage
  }
  'message:abort': {
    request: {
      readonly sessionId: string
    }
    response: void
  }
  'approval:respond': {
    request: ApprovalResponse
    response: void
  }
  'settings:get': {
    request: void
    response: Settings
  }
  'settings:update': {
    request: {
      readonly settings: Settings
    }
    response: Settings
  }
  'managerWorkspace:get': {
    request: void
    response: ManagerWorkspaceState
  }
  'managerWorkspace:migrate': {
    request: ManagerWorkspaceMigrateRequest
    response: ManagerWorkspaceState
  }
  'credential:status': {
    request: void
    response: readonly CredentialStatus[]
  }
  'credential:save': {
    request: {
      readonly providerId: ProviderId
      /** 用户输入的完整 key;只在请求方向出现。 */
      readonly apiKey: string
    }
    /** 只返回掩码状态,绝不回传完整 key。 */
    response: CredentialStatus
  }
  'credential:delete': {
    request: {
      readonly providerId: ProviderId
    }
    response: CredentialStatus
  }
  'credential:test': {
    request: {
      readonly providerId: ProviderId
    }
    response: ConnectivityResult
  }
  /** A-10:填完 key 拉取该厂商可选模型列表(在线拉+本地规格表;在线失败回退默认)。 */
  'credential:listModels': {
    request: {
      readonly providerId: ProviderId
    }
    response: {
      readonly models: readonly ModelOption[]
      /** 在线拉取失败时的中文说明(回退到本地默认列表时给出原因)。 */
      readonly notice?: string
    }
  }
  'reminder:listUpcoming': {
    request: void
    response: readonly Reminder[]
  }
  /** 记忆管理(设置页):全部记事条目;删除按 id。 */
  'memory:list': {
    request: void
    response: readonly MemoryEntry[]
  }
  'memory:delete': {
    request: {
      readonly memoryId: string
    }
    response: {
      readonly deleted: boolean
    }
  }
  /** 使用统计(侧边栏独立入口):一次返回整页数据,四区域同源;筛选由前端本地派生。 */
  'usage:getDashboard': {
    request: void
    response: UsageDashboard
  }
  /** 文件导入:系统多选对话框 → 拷入指定会话的工作文件夹(重名自动改名,不覆盖)。 */
  'workspace:importFiles': {
    request: {
      readonly sessionId: string
    }
    response: readonly ImportedFile[]
  }
  /** 应用更新(设置页"检查更新")。 */
  'app:checkUpdate': {
    request: void
    response: import('../domain/update').UpdateState
  }
  'update:download': {
    request: void
    response: import('../domain/update').UpdateState
  }
  'update:install': {
    request: void
    response: void
  }
  /** 窗口控制(titleBarStyle hidden 后由渲染进程自绘标题栏触发)。 */
  'window:minimize': {
    request: void
    response: void
  }
  'window:toggleMaximize': {
    request: void
    response: void
  }
  'window:close': {
    request: void
    response: void
  }
}

/** 全部通道名 = IpcRequestMap 的键;与 channels.ts 的清单保持一致。 */
export type ContractChannel = keyof IpcRequestMap

export type RequestOf<C extends ContractChannel> = IpcRequestMap[C]['request']
export type ResponseOf<C extends ContractChannel> = IpcRequestMap[C]['response']
