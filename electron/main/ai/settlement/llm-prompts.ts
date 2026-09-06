/**
 * Observer / L1 的 Prompt 纯构建模块（P8.2 A2 抽取）。
 *
 * 目的：让「结算闭环的 LLM prompt」与 orchestrator、离线评测(scripts/eval/llm-run.mjs)共用同一来源，
 * 消除评测与真实管线之间的 prompt 漂移。
 *
 * 约束：纯字符串构建，无任何相对运行时 import → 可被 `node --test` 直接以 `.ts` 导入。
 */

/** Observer：状态变更提取。system+user 与 orchestrator.extractStateDeltaViaLLMWithDiagnostics 同源。 */
export function buildObserverPrompt(input: {
  stateSnapshot: string
  chapterContent: string
  feedback?: string
}): { system: string; user: string } {
  const { stateSnapshot, chapterContent, feedback } = input
  return {
    system: `你是状态变更提取器。根据小说章节正文和当前世界状态，提取本章发生的所有状态变更。
只输出纯JSON，不要解释。JSON结构：
{
  "characters_updated": [{"character_id":"","changes":{"location":{"from":"","to":""},"physical_state":"","mental_state":"","arc_progression":"","power_level":"","inventory_delta":{"added":[],"removed":[]},"new_knowledge":[],"goals_update":{"completed":[],"added":[]}}}],
  "relationships_delta": [{"relationship_id":"","participants":["",""],"status_change":{"from":"","to":"","pivot_event":""},"new_tension_points":[]}],
  "foreshadowing_delta": {"planted":[{"id":"","type":"","description":"","method":""}],"advanced":[{"id":"","clue":"","method":""}],"resolved":[{"id":"","method":"","impact":""}]},
  "timeline": {"story_time_elapsed":"","current_story_date":"","events":[],"world_state_changes":[]}
}
只包含实际发生变更的字段，无变更的字段省略。角色ID使用角色名称。
正文明确陈述了位置移动或当前日期时，必须如实提取到 location.from/to 与 timeline.current_story_date——from 取正文所称的出发地。即使该陈述与已知世界状态冲突（例如一夜到了千里之外、日期倒退），也要照实提取；冲突正是待对账点，不要自行跳过或篡改，留给对账环节判定。
位置 location 请使用城市/区域级（如 边城、皇都、官道），不要写客栈/房间/店铺等细粒度；同一地点内部的移动（如客栈房间→大堂、城内店铺之间）不构成 location 变更，请省略。物品易主（A 交给 B）只在接收方记 added，不要在被转移方记 removed（正文未明示其丢失/销毁时）。
悬念性物件/待解之谜必须记入 foreshadowing_delta：正文埋设了来历不明的物件、信物或谜团（如一枚磨损的旧铜钱、半枚与旧案有关的玉佩）→ 记入 planted，description 写明其异常与待解点；正文揭晓谜底、认领或寻回某悬念（如认出信物、谜底揭晓）→ 记入 resolved。伏笔 id 用物件名。payoff_chapter 省略不填。`,
    user: `当前世界状态：
${stateSnapshot || '（空）'}

本章正文：
${chapterContent}

请提取本章的状态变更JSON：${feedback ? `\n\n注意：上一轮提取未通过校验，问题如下——\n${feedback}\n请只修正提取结果本身，不要臆造正文中没有发生的变更。` : ''}`
  }
}

/** L1：跨章一致性对账。与 orchestrator.reconcileDeltaViaLLMWithDiagnostics 同源。 */
export function buildReconcilePrompt(input: {
  stateSnapshot: string
  chapterContent: string
  deltaJson: string
  feedback?: string
}): { system: string; user: string } {
  const { stateSnapshot, chapterContent, deltaJson, feedback } = input
  return {
    system: `你是跨章一致性对账员。你会拿到：1) 结算前的世界状态（角色/伏笔/关系/时间线/世界规则/倒计时）；2) 本章正文；3) Observer 提取的本章状态增量(JSON)；4) 可选的上轮问题反馈。
请判断该增量/正文与状态是否存在矛盾，例如：delta 声称的 from 位置与账本不符、角色被描述为账本中不可能的状态却在做主动行为、时间线/日期顺序矛盾、违反世界规则、正文明确写了与既定设定冲突的内容。
只输出纯JSON，不要解释。JSON结构：
{"passed": true|false, "issues": [{"category": "location_mismatch"|"item_not_owned"|"timeline_break"|"rule_violation"|"state_conflict", "severity": "error"|"warning"|"hint", "message": "具体说明", "ref": "相关角色/伏笔id(可选)"}]}
特别注意：若 Observer 提取的 timeline.world_state_changes、正文自述或 delta 里出现明显的悖论信号——例如"一夜之间到了千里之外""时间倒退/又回到某日""与已知世界状态冲突"——这几乎必是真矛盾：位置类给出 location_mismatch、日期时序类给出 timeline_break，用 error。不要因为 Observer 已如实提取 delta 就认为无矛盾——矛盾往往正是 delta 所描述的事件与账本/常理冲突本身。只有确凿的跨章矛盾才用 error；疑似用 warning；轻微提示用 hint。无问题则 issues 为空、passed=true。不要臆造正文中没有的矛盾。`,
    user: `当前世界状态：
${stateSnapshot || '（空）'}

本章正文：
${chapterContent}

Observer 提取的状态增量(JSON)：
${deltaJson}

请输出对账结果JSON。${feedback ? `\n\n注意：上一轮结算存在以下问题，请据此修正对账结论：\n${feedback}` : ''}`
  }
}
