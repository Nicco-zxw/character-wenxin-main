/**
 * 结算闭环离线评测语料（确定性，不含 LLM）。
 *
 * 每个 scenario 由若干 chapter 组成。chapter 的 delta 为"Observer 产物"；
 * `extraIssues` 用于模拟 L1(LLM 对账) 注入的 error/warning（当前 L0 规则全部为 warning 级，
 * 无法触发 Arbiter 的拒绝/重试路径，故由上层确定性注入以覆盖该分支）。
 * `retryDelta` 表示自动重观察（attempt=1）得到的修正增量；缺省表示无法重观察 → 拒绝。
 */
function charDelta(id, { from, to }, foreshadowing = {}) {
  return {
    characters_updated: [{
      character_id: id,
      changes: { location: { from, to } }
    }],
    relationships_delta: [],
    foreshadowing_delta: {
      planted: foreshadowing.planted ?? [],
      advanced: foreshadowing.advanced ?? [],
      resolved: foreshadowing.resolved ?? []
    },
    timeline: {
      story_time_elapsed: '',
      current_story_date: '',
      events: [],
      world_state_changes: []
    }
  }
}

/** P5：把 delta 序列化为 Observer 的原始 JSON 输出（可再套 fence/截断做故障注入）。 */
function jsonDelta(id, { from, to }) {
  return JSON.stringify(charDelta(id, { from, to }))
}

export const scenarios = [
  {
    id: 'S1-happy-path',
    name: '连续 3 章正常推进',
    chapters: [
      { index: 0, content: '第0章：林岚抵达边城。', delta: charDelta('林岚', { from: '', to: '边城' }) },
      { index: 1, content: '第1章：林岚前往客栈。', delta: charDelta('林岚', { from: '边城', to: '客栈' }) },
      { index: 2, content: '第2章：林岚出城追凶。', delta: charDelta('林岚', { from: '客栈', to: '城外' }) }
    ]
  },
  {
    id: 'S2-foreshadow-recovery',
    name: '伏笔按计划埋设与回收（回收率 2/3）',
    chapters: [
      {
        index: 0,
        content: '第0章：林岚捡到一枚旧铜钱。',
        delta: charDelta('林岚', { from: '', to: '城门口' }, {
          planted: [
            { id: '伏笔-铜钱', type: '暗线', description: '铜钱来历', method: '道具', payoff_chapter: 1 },
            { id: '伏笔-白影', type: '暗线', description: '深夜白影', method: '对话', payoff_chapter: 2 },
            { id: '伏笔-断剑', type: '暗线', description: '客栈断剑', method: '场景', payoff_chapter: 2 }
          ]
        })
      },
      {
        index: 1,
        content: '第1章：铜钱背面刻着顾川的名字。',
        delta: charDelta('林岚', { from: '城门口', to: '客栈' }, {
          resolved: [{ id: '伏笔-铜钱', method: '揭示', impact: '铜钱属于顾川' }]
        })
      },
      {
        index: 2,
        content: '第2章：白影是刺客留下的幻影。',
        delta: charDelta('林岚', { from: '客栈', to: '后院' }, {
          resolved: [{ id: '伏笔-白影', method: '揭示', impact: '白影为幻术' }]
        })
      }
    ],
    expect: {
      recoveredForeshadowing: 2,
      plannedForeshadowing: 3
    }
  },
  {
    id: 'S3-reject-on-hard-contradiction',
    name: 'L1 注入硬矛盾 → 拒绝落盘，状态不写入',
    chapters: [
      { index: 0, content: '第0章：林岚在边城。', delta: charDelta('林岚', { from: '', to: '边城' }) },
      {
        index: 1,
        content: '第1章：林岚已在皇都（正文与账本矛盾）。',
        delta: charDelta('林岚', { from: '边城', to: '皇都' }),
        extraIssues: [{
          category: 'state_conflict',
          severity: 'error',
          message: '跨章矛盾：账本记录林岚在边城，正文却声称已在皇都（L1 对账确认）',
          ref: '林岚'
        }],
        expectStatus: 'rejected'
      }
    ]
  },
  {
    id: 'S4-auto-reobserve-recovers',
    name: '首轮 error → 自动重观察修正 → 结算成功',
    chapters: [
      { index: 0, content: '第0章：林岚在边城。', delta: charDelta('林岚', { from: '', to: '边城' }) },
      {
        index: 1,
        content: '第1章：林岚离城前往皇都。',
        delta: charDelta('林岚', { from: '客栈', to: '皇都' }),
        extraIssues: [{
          category: 'location_mismatch',
          severity: 'error',
          message: '位置不一致：账本在边城，delta 声称从客栈移动（L1 对账确认）',
          ref: '林岚'
        }],
        // 自动重观察：Observer 修正了 from
        retryDelta: charDelta('林岚', { from: '边城', to: '皇都' }),
        expectStatus: 'settled'
      }
    ]
  },
  {
    id: 'S5-no-state-change-skipped',
    name: '无状态变更 → skip（不落账）',
    chapters: [
      { index: 0, content: '第0章：只有天气描写，无状态变更。', delta: null, expectStatus: 'skipped' }
    ]
  },
  {
    id: 'S6-observer-fault',
    name: 'Observer 输出故障注入（真实 extractJsonObject/normalize 路径）',
    chapters: [
      {
        index: 0,
        content: '第0章：林岚到甲地。',
        observerRaw: jsonDelta('林岚', { from: '', to: '甲地' }),
        expectStatus: 'settled'
      },
      {
        index: 1,
        content: '第1章：林岚到乙地。',
        observerRaw: `\`\`\`json\n${jsonDelta('林岚', { from: '甲地', to: '乙地' })}\n\`\`\``,
        expectStatus: 'settled'
      },
      {
        // 截断 JSON：真实 extractJsonObject 会做尽力修复（补括号）后成功解析
        index: 2,
        content: '第2章：林岚到丙地。',
        observerRaw: jsonDelta('林岚', { from: '乙地', to: '丙地' }).slice(0, -1),
        expectStatus: 'settled'
      },
      {
        // 完全不可解析的输出 → Observer 失败（不落账，计数 observerFailures）
        index: 3,
        content: '第3章：林岚原地不动。',
        observerRaw: '这不是 JSON',
        expectStatus: 'skipped'
      }
    ]
  },
  {
    id: 'S7-deterministic-cross-chapter-conflict',
    name: '跨章可确证矛盾（A1 L0 确定性 error 拦截；无自愈 → 拒绝落盘）',
    chapters: [
      { index: 0, content: '第0章：林岚抵达边城。', delta: charDelta('林岚', { from: '', to: '边城' }), expectStatus: 'settled' },
      {
        // 上章林岚已在「边城」，本章 delta 却声称从「皇都」出发 → runLightCheck 报可确证 location_mismatch error（A1 升级）
        index: 1,
        content: '第1章：林岚从皇都出发去城外（账本记录在边城 → from 矛盾）。',
        delta: charDelta('林岚', { from: '皇都', to: '城外' }),
        expectStatus: 'rejected'
      }
    ]
  }
]
