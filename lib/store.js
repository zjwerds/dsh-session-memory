/**
 * store.js — session-memory.json + vault.json 的读写、原子写、串行队列、坏文件处理。
 *
 * 数据模型见 spec-impl.md §3：
 *  - <dataDir>/session-memory.json：项目记忆，按 sessionId 分桶；坏文件备份为
 *    `.corrupt-<ts>` 后从空库继续（可重建）。
 *  - <dataDir>/vault.json：长期记忆明文（≤60 码点）+ history；坏文件备份后
 *    **fail-closed**：置 blocked，拒绝任何覆盖写，直到人工修复。
 *
 * 约束：
 *  - 目录 0700 / 文件 0600 best-effort（Windows 上 chmod 失败不抛）；
 *  - 写入一律「同目录临时文件 + rename」原子替换；
 *  - 同一文件的写入走模块级 Promise 队列串行，避免交错与 rev 覆盖；
 *  - 读侧提供内存快照（system prompt / guard 是同步回调，不能 await 磁盘）。
 *
 * 本模块零外部依赖，只 import node: 内置模块；可用临时目录直接单测。
 */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  fitEntries,
  normalizeEntryText,
  sanitizeVaultText,
  sumEntriesChars,
  truncateCodePoints,
} from './text.js';

/** 数据文件格式版本（session-memory.json）。 */
export const FORMAT_VERSION = 1;
/** vault.json 格式版本（v0.2：identity + credentials 两段）。 */
export const VAULT_FORMAT_VERSION = 2;
/** 项目记忆文件名。 */
export const SESSION_MEMORY_FILE = 'session-memory.json';
/** 长期记忆文件名。 */
export const VAULT_FILE = 'vault.json';
/** vault history 保留条数上限（防止无限增长）。 */
export const VAULT_HISTORY_LIMIT = 100;

/** 模块级「同文件串行」队列：key = 解析后的绝对路径。 */
const writeQueues = new Map();

/**
 * 把 task 排到某个文件队列尾部；前一个 task 失败不影响后一个。
 * @template T
 * @param {string} filePath
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
export function enqueueFileWrite(filePath, task) {
  const key = String(filePath);
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const current = previous.then(task, task);
  // 队列自身吞掉错误（错误仍会传给 await current 的调用方）。
  writeQueues.set(key, current.catch(() => {}));
  return current;
}

/** 供单测/析构使用：等待某文件的全部排队写入落定。 */
export async function drainFileQueue(filePath) {
  const pending = writeQueues.get(String(filePath));
  if (pending !== undefined) await pending;
}

function tmpPathFor(filePath) {
  const suffix = `${process.pid}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  return `${filePath}.tmp-${suffix}`;
}

function bestEffortChmod(target, mode) {
  try {
    chmodSync(target, mode);
  } catch {
    // Windows 上通常无效；best-effort，不影响功能。
  }
}

/** 确保目录存在（尽量 0700）。 */
export function ensureDataDirSync(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  bestEffortChmod(dir, 0o700);
}

/**
 * 原子写：写同目录临时文件（0600）→ rename 覆盖目标。
 * 任何失败都会尽力清理临时文件并抛出。
 * @param {string} filePath
 * @param {string} content
 */
export function writeFileAtomicSync(filePath, content) {
  const dir = dirname(filePath);
  ensureDataDirSync(dir);
  const tmp = tmpPathFor(filePath);
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
    bestEffortChmod(tmp, 0o600);
    renameSync(tmp, filePath);
    bestEffortChmod(filePath, 0o600);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // 临时文件可能未创建/已 rename；忽略。
    }
    throw error;
  }
}

/** 把 JSON 值原子写盘（2 空格缩进，便于人工检查；不含任何日志输出）。 */
export function writeJsonAtomicSync(filePath, value) {
  writeFileAtomicSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

/** 带错误码的 store 错误（错误信息只含错误码，可安全写日志）。 */
export class StoreError extends Error {
  constructor(code, detail) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'StoreError';
    this.code = code;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function emptySessionState() {
  return { version: FORMAT_VERSION, rev: 0, sessions: {} };
}

function emptyVaultState() {
  return {
    version: VAULT_FORMAT_VERSION,
    rev: 0,
    identity: '',
    credentials: '',
    updatedAt: 0,
    history: [],
  };
}

function clone(value) {
  return value === undefined ? value : structuredClone(value);
}

function cloneRecord(record) {
  return record === null || record === undefined ? null : clone(record);
}

/** 规范化一个会话记录（丢弃非法字段/条目，重算 chars，保留已有 turn/at 元数据）。 */
function normalizeSessionRecord(record, limits) {
  if (!isPlainObject(record)) return null;
  const rawEntries = Array.isArray(record.entries) ? record.entries : [];
  // 条目允许是字符串（模型输出）或 { text, turn, at }（store 内部/落盘形态）。
  const entryTexts = [];
  for (const raw of rawEntries) {
    if (typeof raw === 'string') entryTexts.push(raw);
    else if (isPlainObject(raw) && typeof raw.text === 'string') entryTexts.push(raw.text);
  }
  const fitted = fitEntries(entryTexts, limits);
  const metaByText = new Map();
  for (const raw of rawEntries) {
    if (!isPlainObject(raw) || typeof raw.text !== 'string') continue;
    const key = truncateCodePoints(normalizeEntryText(raw.text) ?? '', limits.entryMaxChars);
    if (key === '' || metaByText.has(key)) continue;
    metaByText.set(key, {
      turn: typeof raw.turn === 'number' && Number.isFinite(raw.turn) ? raw.turn : 0,
      at: typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : 0,
    });
  }
  return {
    cwd: typeof record.cwd === 'string' ? record.cwd : '',
    updatedAt: typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
    chars: fitted.chars,
    entries: fitted.entries.map((text) => ({
      text,
      turn: metaByText.get(text)?.turn ?? 0,
      at: metaByText.get(text)?.at ?? 0,
    })),
  };
}

/** 校验并规范化整个 session-memory 文件；返回 null 表示文件不可信（按坏文件处理）。 */
function normalizeSessionState(parsed, limits) {
  if (!isPlainObject(parsed)) return null;
  if (parsed.version !== FORMAT_VERSION) return null;
  if (!Number.isInteger(parsed.rev) || parsed.rev < 0) return null;
  if (!isPlainObject(parsed.sessions)) return null;
  const sessions = {};
  for (const [sessionId, record] of Object.entries(parsed.sessions)) {
    if (sessionId === '') continue;
    const normalized = normalizeSessionRecord(record, limits);
    if (normalized !== null) sessions[sessionId] = normalized;
  }
  return { version: FORMAT_VERSION, rev: parsed.rev, sessions };
}

/** 校验一段 vault 明文（identity/credentials）：空串合法，非空必须过 sanitizeVaultText。 */
function normalizeVaultText(value, maxChars) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') return null;
  return sanitizeVaultText(value, maxChars);
}

/** 规范化 v2 history 的 prev/next 段（{identity,credentials} 对象；兼容缺省）。 */
function normalizeVaultPair(value, limits) {
  const record = isPlainObject(value) ? value : {};
  const identity = normalizeVaultText(record.identity, limits.identityMaxChars);
  const credentials = normalizeVaultText(record.credentials, limits.credentialsMaxChars);
  if (identity === null || credentials === null) return null;
  return { identity, credentials };
}

/** 规范化 v2 history 条目。 */
function normalizeVaultHistoryEntry(raw, limits) {
  if (!isPlainObject(raw)) return null;
  const prev = normalizeVaultPair(raw.prev, limits);
  const next = normalizeVaultPair(raw.next, limits);
  if (prev === null || next === null) return null;
  return {
    at: typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : 0,
    prev,
    next,
    reason: typeof raw.reason === 'string' ? truncateCodePoints(raw.reason, 120) : '',
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
    turn: typeof raw.turn === 'number' && Number.isFinite(raw.turn) ? raw.turn : 0,
  };
}

/**
 * 校验并规范化 vault 文件；返回 null 表示不可信（fail-closed）。
 * - v2：identity + credentials 两段，history prev/next 为两段对象；
 * - v1（旧版）：`{text}` → credentials=text、identity=''，history 的 prev/next 字符串
 *   映射为 `{identity:'', credentials:旧串}`（保留旧密码过滤能力）。
 */
function normalizeVaultState(parsed, limits) {
  if (!isPlainObject(parsed)) return null;
  if (!Number.isInteger(parsed.rev) || parsed.rev < 0) return null;
  const updatedAt = typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0;

  if (parsed.version === VAULT_FORMAT_VERSION) {
    const identity = normalizeVaultText(parsed.identity, limits.identityMaxChars);
    const credentials = normalizeVaultText(parsed.credentials, limits.credentialsMaxChars);
    if (identity === null || credentials === null) return null;
    const history = [];
    if (Array.isArray(parsed.history)) {
      for (const raw of parsed.history) {
        const entry = normalizeVaultHistoryEntry(raw, limits);
        if (entry !== null) history.push(entry);
      }
    }
    return {
      version: VAULT_FORMAT_VERSION,
      rev: parsed.rev,
      identity,
      credentials,
      updatedAt,
      history: history.slice(-VAULT_HISTORY_LIMIT),
    };
  }

  // v1 迁移：{version:1, text, history:[{prev:string,next:string,...}]}
  if (parsed.version === 1) {
    const credentials = normalizeVaultText(parsed.text, limits.credentialsMaxChars);
    if (credentials === null) return null;
    const history = [];
    if (Array.isArray(parsed.history)) {
      for (const raw of parsed.history) {
        if (!isPlainObject(raw)) continue;
        if (typeof raw.prev !== 'string' || typeof raw.next !== 'string') continue;
        const prev = normalizeVaultPair({ identity: '', credentials: raw.prev }, limits);
        const next = normalizeVaultPair({ identity: '', credentials: raw.next }, limits);
        if (prev === null || next === null) continue;
        history.push({
          at: typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : 0,
          prev,
          next,
          reason: typeof raw.reason === 'string' ? truncateCodePoints(raw.reason, 120) : '',
          sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
          turn: typeof raw.turn === 'number' && Number.isFinite(raw.turn) ? raw.turn : 0,
        });
      }
    }
    return {
      version: VAULT_FORMAT_VERSION,
      rev: parsed.rev,
      identity: '',
      credentials,
      updatedAt,
      history: history.slice(-VAULT_HISTORY_LIMIT),
    };
  }
  return null;
}

/**
 * MemoryStore：内存快照 + 原子持久化。
 *
 * 构造时同步读盘（system prompt / guard 需要同步读），读失败不抛：
 *  - session-memory 读坏 → 备份后空库继续；
 *  - vault 读坏/不可读 → 备份后 blocked=true，所有写被拒（fail-closed）。
 */
export class MemoryStore {
  /**
   * @param {object} options
   * @param {string} options.dataDir
   * @param {number} [options.entryMaxChars]
   * @param {number} [options.projectMaxChars]
   * @param {number} [options.identityMaxChars] - 用户身份预算（v0.2）
   * @param {number} [options.credentialsMaxChars] - 账号密码预算（v0.2）
   * @param {number} [options.longtermMaxChars] - 兼容别名 → credentialsMaxChars
   * @param {() => number} [options.now]
   * @param {(code:string, info?:object) => void} [options.onWarn] - 只接受错误码/数值
   */
  constructor(options) {
    if (!isPlainObject(options) || typeof options.dataDir !== 'string' || options.dataDir === '') {
      throw new StoreError('BAD_DATA_DIR');
    }
    this.dataDir = options.dataDir;
    this.sessionPath = join(this.dataDir, SESSION_MEMORY_FILE);
    this.vaultPath = join(this.dataDir, VAULT_FILE);
    this.limits = {
      entryMaxChars: options.entryMaxChars,
      projectMaxChars: options.projectMaxChars,
      identityMaxChars: options.identityMaxChars,
      credentialsMaxChars: options.credentialsMaxChars ?? options.longtermMaxChars,
      drop: 'tail',
    };
    this.#now = typeof options.now === 'function' ? options.now : Date.now;
    this.#onWarn = typeof options.onWarn === 'function' ? options.onWarn : () => {};
    this.#ensureDir();
    this.#session = this.#readSessionSafe();
    this.#vault = this.#readVaultSafe();
  }

  #now;
  #onWarn;
  /** @type {{version:number, rev:number, sessions:Record<string,object>}} */
  #session;
  /** @type {{version:number, rev:number, identity:string, credentials:string, updatedAt:number, history:object[]}} */
  #vault;
  #vaultBlocked = false;

  #ensureDir() {
    try {
      ensureDataDirSync(this.dataDir);
    } catch (error) {
      this.#onWarn('DATA_DIR_CREATE_FAILED', { code: error?.code });
    }
  }

  /** 备份坏文件：`<file>.corrupt-<ts>`；失败只记错误码。 */
  #backupCorrupt(filePath, code) {
    const backup = `${filePath}.corrupt-${this.#now()}`;
    try {
      renameSync(filePath, backup);
      this.#onWarn(code, { backup: true });
    } catch (error) {
      this.#onWarn(code, { backup: false, code: error?.code });
    }
  }

  #readSessionSafe(forWrite = false) {
    let raw;
    try {
      raw = readFileSync(this.sessionPath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.#onWarn('SESSION_STORE_READ_FAILED', { code: error?.code });
        // 读不了 ≠ 空库：写入路径必须放弃，避免把不可读的旧数据覆盖成空库。
        if (forWrite) throw new StoreError('SESSION_STORE_READ_FAILED');
      }
      return emptySessionState();
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.#backupCorrupt(this.sessionPath, 'SESSION_STORE_CORRUPT_RECOVERED');
      return emptySessionState();
    }
    const state = normalizeSessionState(parsed, this.limits);
    if (state === null) {
      this.#backupCorrupt(this.sessionPath, 'SESSION_STORE_CORRUPT_RECOVERED');
      return emptySessionState();
    }
    return state;
  }

  #readVaultSafe(forWrite = false) {
    let raw;
    try {
      raw = readFileSync(this.vaultPath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // 读不了 ≠ 空库：fail-closed，避免把不可读的旧密文覆盖掉。
        this.#vaultBlocked = true;
        this.#onWarn('VAULT_READ_FAILED', { code: error?.code });
        if (forWrite) throw new StoreError('VAULT_CORRUPT');
      }
      return emptyVaultState();
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.#vaultBlocked = true;
      this.#backupCorrupt(this.vaultPath, 'VAULT_CORRUPT_BLOCKED');
      return emptyVaultState();
    }
    const state = normalizeVaultState(parsed, this.limits);
    if (state === null) {
      this.#vaultBlocked = true;
      this.#backupCorrupt(this.vaultPath, 'VAULT_CORRUPT_BLOCKED');
      return emptyVaultState();
    }
    return state;
  }

  /** session-memory 当前内存快照的深拷贝。 */
  sessionState() {
    return clone(this.#session);
  }

  /** vault 当前内存快照的深拷贝。 */
  vaultState() {
    return clone(this.#vault);
  }

  /** vault 是否处于 fail-closed（坏文件后禁止覆盖）。 */
  isVaultBlocked() {
    return this.#vaultBlocked;
  }

  /** 当前项目记忆条目的文本数组（同步，供注入用）。 */
  projectEntries(sessionId) {
    if (typeof sessionId !== 'string') return [];
    const record = this.#session.sessions[sessionId];
    if (!record) return [];
    return record.entries.map((entry) => entry.text);
  }

  /** 当前会话项目记忆快照（同步，供工具/注入用）。 */
  projectSnapshot(sessionId) {
    if (typeof sessionId !== 'string') return { rev: this.#session.rev, record: null };
    const record = this.#session.sessions[sessionId];
    return { rev: this.#session.rev, record: record === undefined ? null : clone(record) };
  }

  /** vault 用户身份明文（空库/未记录返回 ''）。 */
  vaultIdentity() {
    return this.#vault.identity;
  }

  /** vault 账号密码明文（空库返回 ''）。 */
  vaultCredentials() {
    return this.#vault.credentials;
  }

  /** 兼容旧调用：vault 账号密码明文（等价 vaultCredentials()）。 */
  vaultText() {
    return this.#vault.credentials;
  }

  /**
   * vault 里「用户身份」的明文列表（当前 identity + history prev/next 的 identity，去重去空）。
   * task-12：identity 片段要用更短的阈值过滤，故单独暴露而不是混在 vaultSecretTexts 里。
   * @returns {string[]}
   */
  vaultIdentityTexts() {
    const texts = new Set();
    if (this.#vault.identity !== '') texts.add(this.#vault.identity);
    for (const entry of this.#vault.history) {
      for (const pair of [entry.prev, entry.next]) {
        if (isPlainObject(pair) && typeof pair.identity === 'string' && pair.identity !== '') texts.add(pair.identity);
      }
    }
    return [...texts];
  }

  /**
   * vault 里「账号密码」的明文列表（当前 credentials + history prev/next 的 credentials，去重去空）。
   * @returns {string[]}
   */
  vaultCredentialTexts() {
    const texts = new Set();
    if (this.#vault.credentials !== '') texts.add(this.#vault.credentials);
    for (const entry of this.#vault.history) {
      for (const pair of [entry.prev, entry.next]) {
        if (isPlainObject(pair) && typeof pair.credentials === 'string' && pair.credentials !== '') texts.add(pair.credentials);
      }
    }
    return [...texts];
  }

  /**
   * vault 全部历史明文（identity + credentials + history 各段，去重去空）。
   * task-8 R1.3 + task-11 A.6：轮换后的旧密码/旧身份同样不能进 project memory / 注入段 / 工具参数。
   * @returns {string[]}
   */
  vaultSecretTexts() {
    return [...new Set([...this.vaultIdentityTexts(), ...this.vaultCredentialTexts()])];
  }

  /** vault 快照（含 rev/updatedAt；v0.2 两段明文）。 */
  vaultSnapshot() {
    return {
      rev: this.#vault.rev,
      identity: this.#vault.identity,
      credentials: this.#vault.credentials,
      updatedAt: this.#vault.updatedAt,
    };
  }

  /** 全部会话的项目记忆摘要（按 updatedAt 倒序；不含长期记忆）。 */
  listSessions() {
    return Object.entries(this.#session.sessions)
      .map(([sessionId, record]) => ({
        sessionId,
        cwd: record.cwd,
        updatedAt: record.updatedAt,
        chars: record.chars,
        entries: record.entries.length,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * 更新某会话的项目记忆（rev 乐观锁：expectedRev 不符时从磁盘重读一次再应用）。
   * @param {string} sessionId
   * @param {(record: object|null) => object|null} mutator - 返回 null 表示不写
   * @param {{expectedRev?:number}} [options]
   * @returns {Promise<{changed:boolean, rev:number, record:object|null}>}
   */
  async updateProjectMemory(sessionId, mutator, options = {}) {
    if (typeof sessionId !== 'string' || sessionId === '') throw new StoreError('BAD_SESSION_ID');
    if (typeof mutator !== 'function') throw new StoreError('BAD_MUTATOR');
    return enqueueFileWrite(this.sessionPath, async () => {
      // 「读最新 → 写」：在队列内重读磁盘，外部写者/进程重启后的更新不会被覆盖。
      const state = this.#readSessionSafe(true);
      this.#session = state;
      // rev 乐观锁：调用方快照的 rev 与最新 rev 不符时（已被其它分析更新），
      // 已经在上面重读过一次；把 mutator 应用到最新记录上即可。
      const current = state.sessions[sessionId] ?? null;
      const nextRecord = mutator(cloneRecord(current));
      if (nextRecord === null || nextRecord === undefined) {
        return { changed: false, rev: this.#session.rev, record: current === null ? null : clone(current) };
      }
      const normalized = normalizeSessionRecord(nextRecord, this.limits);
      if (normalized === null) throw new StoreError('BAD_SESSION_RECORD');
      const nextState = {
        version: FORMAT_VERSION,
        rev: state.rev + 1,
        sessions: { ...state.sessions, [sessionId]: normalized },
      };
      writeJsonAtomicSync(this.sessionPath, nextState);
      this.#session = nextState;
      return { changed: true, rev: nextState.rev, record: clone(normalized) };
    });
  }

  /**
   * 更新长期记忆（v0.2 identity + credentials 两段）：两段都不变则 no-op；
   * 任一变化则写盘并 push history（prev/next 均为 {identity,credentials} 对象）。
   * 坏 vault（blocked）时抛 StoreError('VAULT_CORRUPT')，绝不覆盖。
   * @param {{identity?:string, credentials?:string}} next - 已由 sanitizeVaultText 校验过的明文；
   *   缺省段保持当前值。
   * @param {{reason?:string, sessionId?:string, turn?:number}} [meta]
   * @param {{expectedRev?:number}} [options]
   * @returns {Promise<{changed:boolean, rev:number}>}
   */
  async updateVault(next, meta = {}, options = {}) {
    return enqueueFileWrite(this.vaultPath, async () => {
      if (this.#vaultBlocked) throw new StoreError('VAULT_CORRUPT');
      // 只有「显式提供」的段才参与校验/更新；缺省段保持当前值（partial update）。
      const source = next !== null && typeof next === 'object' ? next : {};
      const providedIdentity = Object.hasOwn(source, 'identity') && source.identity !== undefined;
      const providedCredentials = Object.hasOwn(source, 'credentials') && source.credentials !== undefined;
      const nextIdentity = providedIdentity
        ? normalizeVaultText(source.identity, this.limits.identityMaxChars)
        : undefined;
      const nextCredentials = providedCredentials
        ? normalizeVaultText(source.credentials, this.limits.credentialsMaxChars)
        : undefined;
      if (nextIdentity === null) throw new StoreError('BAD_IDENTITY_TEXT');
      if (nextCredentials === null) throw new StoreError('BAD_CREDENTIALS_TEXT');
      // 「读最新 → 写」：队列内重读磁盘；若磁盘 vault 此刻损坏则 fail-closed。
      let state = this.#readVaultSafe(true);
      this.#vault = state;
      if (this.#vaultBlocked) throw new StoreError('VAULT_CORRUPT');
      const identity = providedIdentity ? nextIdentity : state.identity;
      const credentials = providedCredentials ? nextCredentials : state.credentials;
      if (identity === state.identity && credentials === state.credentials) {
        return { changed: false, rev: state.rev };
      }
      const now = this.#now();
      const historyEntry = {
        at: now,
        prev: { identity: state.identity, credentials: state.credentials },
        next: { identity, credentials },
        reason: typeof meta.reason === 'string' ? truncateCodePoints(meta.reason, 120) : '',
        sessionId: typeof meta.sessionId === 'string' ? meta.sessionId : '',
        turn: typeof meta.turn === 'number' && Number.isFinite(meta.turn) ? meta.turn : 0,
      };
      const history = [...state.history, historyEntry].slice(-VAULT_HISTORY_LIMIT);
      const nextState = {
        version: VAULT_FORMAT_VERSION,
        rev: state.rev + 1,
        identity,
        credentials,
        updatedAt: now,
        history,
      };
      writeJsonAtomicSync(this.vaultPath, nextState);
      this.#vault = nextState;
      return { changed: true, rev: nextState.rev };
    });
  }

  /** 等待该 store 两个文件的全部排队写入落定（测试/析构用）。 */
  async flush() {
    await drainFileQueue(this.sessionPath);
    await drainFileQueue(this.vaultPath);
  }
}

/** 汇总一组条目对象的码点总量（供工具渲染）。 */
export function entriesCharCount(entries) {
  return sumEntriesChars(entries);
}
