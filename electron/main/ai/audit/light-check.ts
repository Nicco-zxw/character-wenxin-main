import type { StoryStateContext, CharacterState } from '../../story-state-store'
import type { StateDelta } from '../../story-state-store'

/** 轻量检查发现的单条违规记录 */
export interface LightCheckViolation {
  type: 'location_mismatch' | 'item_not_owned' | 'timeline_break' | 'rule_violation' | 'state_conflict' | 'teleport_suspected'
  severity: 'error' | 'warning'
  message: string
}

/** 轻量检查的汇总结果 */
export interface LightCheckResult {
  passed: boolean
  violations: LightCheckViolation[]
}

/** A1：是否把「可确证」的确定性矛盾升级为 error（默认开；置 false 回退为全 warning）。 */
export const LIGHT_CHECK_ERROR_UPGRADE = true

/**
 * 执行轻量一致性检查，扫描章节内容与状态 delta 中的潜在问题
 * @param chapterContent - 章节正文文本
 * @param stateBefore - 执行 delta 前的完整故事状态
 * @param delta - 本章产生的状态变更（null 表示无变更）
 * @param opts - 可选：errorUpgrade=false 关闭「可确证矛盾升级 error」回退
 * @returns 检查结果，包含是否通过及违规列表
 */
export function runLightCheck(
  chapterContent: string,
  stateBefore: StoryStateContext,
  delta: StateDelta | null,
  opts?: { errorUpgrade?: boolean }
): LightCheckResult {
  const violations: LightCheckViolation[] = []
  // errorUpgrade 缺省跟随全局常量（可整体回退为全 warning 语义）
  const upgrade = opts?.errorUpgrade ?? LIGHT_CHECK_ERROR_UPGRADE

  if (!delta) {
    return { passed: true, violations }
  }

  checkItemConsistency(chapterContent, stateBefore.characterStates, delta, violations)
  checkLocationConsistency(stateBefore.characterStates, delta, violations, upgrade)
  checkWorldRuleViolations(chapterContent, stateBefore.worldRules, violations)
  checkStateConflicts(stateBefore.characterStates, delta, violations, upgrade)
  checkTimelineBreak(stateBefore.recentTimeline, delta, violations, upgrade)
  checkTeleportSuspicion(stateBefore.characterStates, delta, violations, stateBefore.worldRules)

  return {
    passed: violations.filter((v) => v.severity === 'error').length === 0,
    violations
  }
}

/**
 * 检查物品移除是否与角色库存一致。
 * R4：真实叙事里"物品易主/持有未记账物品"非常普遍（如 A 把未入账的家传物交给 B，Observer 记 B removed）——
 * "账本未记录该物品" ≠ "该角色不可能拥有"，不可确证 → 恒 warning（不随 errorUpgrade 升级）。
 */
function checkItemConsistency(
  content: string,
  characterStates: CharacterState[],
  delta: StateDelta,
  violations: LightCheckViolation[]
): void {
  for (const charUpdate of delta.characters_updated) {
    const removed = charUpdate.changes.inventory_delta?.removed ?? []
    if (!removed.length) continue

    const charState = characterStates.find((c) => c.characterId === charUpdate.character_id)
    if (!charState) continue

    for (const item of removed) {
      if (!charState.inventory.includes(item)) {
        violations.push({
          type: 'item_not_owned',
          severity: 'warning',
          message: `角色「${charUpdate.character_id}」移除了物品「${item}」，但状态库中未记录该物品`
        })
      }
    }
  }
}

/** A2b-R1：同一地点的不同粒度写法视为一致（如账本「宣化府」vs delta from「宣化府城门外茶棚」）；不同地（S7 边城 vs 皇都）不包含 → 仍 mismatch。 */
function locationsCompatible(a: string, b: string): boolean {
  const x = a.trim()
  const y = b.trim()
  if (!x || !y) return false
  return x === y || x.includes(y) || y.includes(x)
}

/** 检查角色位置变更的 from 值是否与状态库一致（可确证：from 明确且 ≠ 状态库位置，且非同地不同粒度） */
function checkLocationConsistency(
  characterStates: CharacterState[],
  delta: StateDelta,
  violations: LightCheckViolation[],
  upgrade: boolean
): void {
  for (const charUpdate of delta.characters_updated) {
    const locationChange = charUpdate.changes.location
    if (!locationChange) continue

    const charState = characterStates.find((c) => c.characterId === charUpdate.character_id)
    if (!charState) continue

    if (charState.location && locationChange.from && !locationsCompatible(charState.location, locationChange.from)) {
      violations.push({
        type: 'location_mismatch',
        severity: upgrade ? 'error' : 'warning',
        message: `角色「${charUpdate.character_id}」位置不一致：状态库记录在「${charState.location}」，但 delta 声称从「${locationChange.from}」移动`
      })
    }
  }
}

/** 通过关键词匹配检测正文是否可能违反强制世界规则 */
function checkWorldRuleViolations(
  content: string,
  worldRules: StoryStateContext['worldRules'],
  violations: LightCheckViolation[]
): void {
  const contentLower = content.toLowerCase()

  for (const rule of worldRules) {
    if (!rule.mustComply) continue

    const ruleKeywords = extractRuleKeywords(rule.ruleContent)
    if (!ruleKeywords.length) continue

    const isConstraintRule = /[不禁]|无法|只能|必须/.test(rule.ruleContent)
    const matchedKeywords = ruleKeywords.filter((kw) => contentLower.includes(kw.toLowerCase()))
    const threshold = isConstraintRule ? 2 : 3

    if (matchedKeywords.length >= threshold) {
      violations.push({
        type: 'rule_violation',
        severity: 'warning',
        message: `可能违反世界规则「${rule.ruleContent}」（第${rule.establishedChapter}章确立）— 正文中出现相关关键词`
      })
    }
  }
}

/** 检测昏迷/死亡角色被报告有主动行为变更但未恢复状态的冲突（可确证） */
function checkStateConflicts(
  characterStates: CharacterState[],
  delta: StateDelta,
  violations: LightCheckViolation[],
  upgrade: boolean
): void {
  for (const charUpdate of delta.characters_updated) {
    const charState = characterStates.find((c) => c.characterId === charUpdate.character_id)
    if (!charState) continue

    if (charState.physicalState.includes('昏迷') || charState.physicalState.includes('死亡')) {
      const hasActiveChanges = charUpdate.changes.goals_update ||
        charUpdate.changes.arc_progression ||
        charUpdate.changes.power_level
      if (hasActiveChanges && !charUpdate.changes.physical_state) {
        violations.push({
          type: 'state_conflict',
          severity: upgrade ? 'error' : 'warning',
          message: `角色「${charUpdate.character_id}」当前状态为「${charState.physicalState}」，但 delta 报告了主动行为变更且未恢复状态`
        })
      }
    }
  }
}

/** 从规则文本中提取有意义的关键词（去除虚词和标点，最多 8 个） */
function extractRuleKeywords(ruleContent: string): string[] {
  return ruleContent
    .replace(/[，。、；：""''（）【】！？…—·「」『』]/g, ' ')
    .replace(/(?:不能|不可|无法|不得|禁止|不会|不要|必须|只能|可以|应该|需要|的|了|是|在|有|和|与|或|而|但|也|都|就|才|又|被|把|让|给|对|从|向|到|以|为|于|之)/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .slice(0, 8)
}

/* ---------- R3：中文历法日期倒退的确定性检查（timeline_break） ---------- */

const CN_MONTH: Record<string, number> = {
  正月: 1, 腊月: 12,
  一月: 1, 二月: 2, 三月: 3, 四月: 4, 五月: 5, 六月: 6,
  七月: 7, 八月: 8, 九月: 9, 十月: 10, 十一月: 11, 十二月: 12
}

const CN_DAY: Record<string, number> = {
  初一: 1, 初二: 2, 初三: 3, 初四: 4, 初五: 5, 初六: 6, 初七: 7, 初八: 8, 初九: 9, 初十: 10,
  十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15, 十六: 16, 十七: 17, 十八: 18, 十九: 19,
  二十: 20, 廿一: 21, 廿二: 22, 廿三: 23, 廿四: 24, 廿五: 25, 廿六: 26, 廿七: 27, 廿八: 28, 廿九: 29,
  三十: 30
}

const MONTH_KEYS = Object.keys(CN_MONTH).sort((a, b) => b.length - a.length)
const DAY_KEYS = Object.keys(CN_DAY).sort((a, b) => b.length - a.length)

/** 解析中文历法日期（如「腊月初三」「正月十五」）→ {m,d}；无法解析返回 null。 */
function parseChineseStoryDate(raw: string): { m: number; d: number } | null {
  const month = MONTH_KEYS.find((k) => raw.startsWith(k))
  if (!month) return null
  const rest = raw.slice(month.length)
  const day = DAY_KEYS.find((k) => rest.startsWith(k))
  if (!day) return null
  return { m: CN_MONTH[month], d: CN_DAY[day] }
}

/** 日期是否倒回（腊月→正月视为跨年推进，不算倒退）。 */
function isDateRegression(cur: { m: number; d: number }, last: { m: number; d: number }): boolean {
  if (cur.m < last.m) return !(cur.m === 1 && last.m === 12)
  if (cur.m > last.m) return false
  return cur.d < last.d
}

/** 取账本最近一条有日期的 timeline entry 的原始日期串。 */
function lastStoryDate(recentTimeline: { chapterIndex: number; storyDate: string }[]): string | null {
  let best: string | null = null
  for (const entry of recentTimeline) {
    if (entry.storyDate) best = entry.storyDate
  }
  return best
}

/** 检查 delta 声称的当前日期是否早于账本最近日期（可确证：中文历法倒退 → timeline_break）。 */
function checkTimelineBreak(
  recentTimeline: { chapterIndex: number; storyDate: string }[],
  delta: StateDelta,
  violations: LightCheckViolation[],
  upgrade: boolean
): void {
  const curRaw = delta.timeline?.current_story_date
  const lastRaw = lastStoryDate(recentTimeline)
  if (!curRaw || !lastRaw) return
  const cur = parseChineseStoryDate(curRaw)
  const last = parseChineseStoryDate(lastRaw)
  if (!cur || !last) return
  if (!isDateRegression(cur, last)) return
  violations.push({
    type: 'timeline_break',
    severity: upgrade ? 'error' : 'warning',
    message: `时间倒回：账本时间线已推进到「${lastRaw}」，但 delta 声称当前为「${curRaw}」`
  })
}

/* ---------- ③ A2b：无解释瞬移护栏（teleport_suspected，warning 化 + 设定登记豁免） ---------- */

/** 短时移动提示词：极短 elapsed 下跨地 = 速度存疑。 */
const SHORT_TRAVEL_HINTS = ['一夜', '转瞬', '眨眼', '须臾', '刹那间', '片刻间', '瞬息']

/** 惊讶/无解释信号词（正文自述或 world_state_changes 出现 → 事件本身异常）。 */
const WONDER_HINTS = ['骇然', '惊骇', '竟', '莫名', '无法解释', '瞬移', '千里之外', '怎么会', '怎会', '诡异', '蹊跷', '位移']

/** 世界规则若已登记这类超自然位移许可 → 豁免（有意设定不误报）。 */
const TELEPORT_RULE_HINTS = ['瞬移', '传送', '空间', '瞬间移动', '缩地成寸', '挪移']

/**
 * 无解释瞬移护栏（③）：角色位置跨地跳跃（from→to 非同一地点）+ 极短 elapsed + 正文/状态含惊讶/无解释信号，
 * 且项目 world_rules 未登记瞬移类许可 → 报 teleport_suspected（warning）。
 * 语义：L1 能拦则拦（reject）；L0 此护栏至少让"静默放行的怪谈瞬移"可见、可登记豁免——
 * 无地图数据无法判"距离合理性"，故不硬拒（避免误伤有意的超自然情节），由作者登记或改稿消解。
 */
function checkTeleportSuspicion(
  characterStates: CharacterState[],
  delta: StateDelta,
  violations: LightCheckViolation[],
  worldRules: StoryStateContext['worldRules']
): void {
  const licensed = (worldRules ?? []).some((r) =>
    TELEPORT_RULE_HINTS.some((k) => r.ruleContent.includes(k))
  )
  if (licensed) return

  const elapsed = delta.timeline?.story_time_elapsed ?? ''
  const signals = [
    ...(delta.timeline?.world_state_changes ?? []),
    ...(delta.timeline?.events ?? [])
  ].join(' ')
  const shortTravel = SHORT_TRAVEL_HINTS.some((k) => elapsed.includes(k))
  const wonder = WONDER_HINTS.some((k) => signals.includes(k))
  if (!shortTravel || !wonder) return

  for (const charUpdate of delta.characters_updated) {
    const lc = charUpdate.changes.location
    if (!lc?.from || !lc?.to) continue
    if (locationsCompatible(lc.from, lc.to)) continue
    violations.push({
      type: 'teleport_suspected',
      severity: 'warning',
      message: `角色「${charUpdate.character_id}」疑似无解释瞬移：${lc.from} → ${lc.to}（elapsed「${elapsed}」，正文含异常信号）。若为超自然设定请在 world_rules 登记瞬移/传送类规则；否则疑为笔误`
    })
    break // 每 delta 报一条足矣（提示作者核对该处瞬移）
  }
}

