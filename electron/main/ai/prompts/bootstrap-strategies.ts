/** 小说篇幅类型 */
type NovelLength = 'short' | 'long'

/** 题材启动策略各维度的引导语 */
interface BootstrapStrategy {
  storyFocus: string
  worldviewBias: string
  conflictStyle: string
  outlineShape: string
  toneConstraints: string
}

/** 未匹配到具体题材时的默认启动策略 */
const DEFAULT_STRATEGY: BootstrapStrategy = {
  storyFocus: '先锁定主角最明确的欲望、最现实的阻力和最有辨识度的切入场景。',
  worldviewBias: '世界观只保留最支撑剧情推进的 3 条骨架信息，避免泛泛堆设定。',
  conflictStyle: '冲突要尽快落到人物选择、利益碰撞或情绪压力上，不写空泛口号。',
  outlineShape: '三条大纲要形成起势、升级、钩子收束的连续推进。',
  toneConstraints: '语言保持中文网文可读性，重视画面感、目标感和悬念。'
}

/** 各题材对应的启动策略 */
const GENRE_STRATEGIES: Record<string, BootstrapStrategy> = {
  科幻: { storyFocus: '优先明确核心科技设定、社会秩序变化，以及主角如何被卷入其中。', worldviewBias: '多写技术规则、资源分配、城市生态或文明断层，不写空洞名词。', conflictStyle: '冲突以技术代价、认知差异、制度压迫或生存抉择为主。', outlineShape: '先抛异常，再暴露系统性问题，最后给出更大阴影或实验真相。', toneConstraints: '兼顾冷感想象与人性压力，避免纯说明书式设定堆砌。' },
  奇幻: { storyFocus: '先确定主角进入异世界秩序后的生存目标和力量诱因。', worldviewBias: '多写地域风貌、超凡规则、族群差异和古老禁忌。', conflictStyle: '冲突以试炼、阵营纷争、宿命牵引和代价交换为主。', outlineShape: '以异象或事件开局，逐步引出更大的势力棋局。', toneConstraints: '要有冒险感和奇观感，但核心仍围绕人物选择。' },
  仙侠: { storyFocus: '明确主角求生、求道或逆袭的起点，以及最初资源缺口。', worldviewBias: '多写修行法则、门派秩序、资源层级和因果代价。', conflictStyle: '冲突强调实力差、资源争夺、师门规训和心性考验。', outlineShape: '先立弱势困局，再给机缘入口，随后迅速出现同阶或上位压制。', toneConstraints: '要有修行进阶感，但避免流水账式升级。' },
  都市: { storyFocus: '先锁定主角在现实秩序中的身份处境、核心欲望和现实压力。', worldviewBias: '世界观聚焦行业生态、阶层差异、城市空间和社会规则。', conflictStyle: '冲突应贴近利益、关系、舆论、职场或家庭压力。', outlineShape: '先给现实难题，再出现破局契机，最后埋下更高层压力。', toneConstraints: '保持现实质感，少悬浮，少空喊逆袭。' },
  悬疑: { storyFocus: '优先明确案件、谜团或异常事件与主角的直接关系。', worldviewBias: '世界观服务线索链和真相反差，不做无关扩展。', conflictStyle: '冲突以信息差、误导、时间压力和信任崩塌为主。', outlineShape: '三条大纲应形成发现异常、深入调查、反转钩子。', toneConstraints: '保持克制和压迫感，避免一上来透光全部底牌。' },
  历史: { storyFocus: '明确时代背景下主角最现实的立身难题与行动目标。', worldviewBias: '多写制度、地缘、人情秩序和时代风貌。', conflictStyle: '冲突围绕身份、立场、家族、政局或生存资源展开。', outlineShape: '先通过具体事件落地时代，再逐步拉出更大局势。', toneConstraints: '有时代气息，但不要写成资料摘抄。' },
  言情: { storyFocus: '主线必须同时包含情感牵引和现实处境，不能只剩恋爱对白。', worldviewBias: '世界观聚焦人物关系场、家庭/职场/身份差异和情感禁区。', conflictStyle: '冲突以误解、拉扯、身份阻碍、旧伤或价值观冲突为主。', outlineShape: '先制造吸引与不对位，再升级拉扯，最后留下情感钩子。', toneConstraints: '情绪要细腻，但不能空转，要有事件推动。' },
  恐怖: { storyFocus: '先确定恐惧源、规则漏洞和主角无法回避的处境。', worldviewBias: '世界观围绕禁忌空间、污染规则、传闻与异常机制展开。', conflictStyle: '冲突强调未知、压迫、认知崩裂和生存倒计时。', outlineShape: '由异样进入，快速触发规则，再以更大恐惧收束。', toneConstraints: '氛围优先，少解释过满，让危险感持续存在。' },
  校园: { storyFocus: '主角目标要和成长、友情、竞争或情感困境直接绑定。', worldviewBias: '多写班级生态、社团秩序、家庭影响和青春场景。', conflictStyle: '冲突围绕自我认同、成绩、关系变化和青春压力。', outlineShape: '先建立校园日常，再打破平衡，最后抛出下一轮情绪冲突。', toneConstraints: '要有青春现场感，避免成人化说教。' },
  轻小说: { storyFocus: '先明确高概念设定和主角的鲜明反应机制。', worldviewBias: '世界观突出设定梗、阵营趣味和可持续展开的规则。', conflictStyle: '冲突强调设定差异、人物互动火花和轻快推进。', outlineShape: '开局即给设定亮点，中段放大反差，尾部抛新梗。', toneConstraints: '节奏轻快、画面明确，但不能失去故事主线。' },
  末世: { storyFocus: '明确灾变机制、主角第一生存目标和最紧缺资源。', worldviewBias: '多写生存秩序、资源系统、据点生态和人性失衡。', conflictStyle: '冲突以生存竞争、信任危机、规则崩坏和环境威胁为主。', outlineShape: '先给危机现场，再建立临时秩序，随后撕开更大灾难面。', toneConstraints: '压迫感要足，但不能只剩喊杀和堆惨。' },
  游戏竞技: { storyFocus: '主角的竞技目标、团队位置和关键短板要尽快明确。', worldviewBias: '世界观聚焦赛事体系、版本规则、队伍关系和职业生态。', conflictStyle: '冲突应围绕比赛、磨合、舆论、操作差距和心态波动。', outlineShape: '先给竞技舞台，再暴露团队问题，最后抛关键对局钩子。', toneConstraints: '专业术语要能落地，别写成空热血。' },
  古言: { storyFocus: '先确定主角在礼法和家族结构中的处境与目标。', worldviewBias: '多写门第、婚配、家宅秩序、朝局投影和女性生存空间。', conflictStyle: '冲突围绕身份、婚姻、家族利益和情感压抑展开。', outlineShape: '以具体礼俗场景切入，再引出人物博弈与后续风波。', toneConstraints: '情绪细致，但必须有局势推动。' },
  现言: { storyFocus: '优先明确人物现实处境、关系拉扯和情感缺口。', worldviewBias: '世界观聚焦都市生活、职业关系、家庭创伤和情感边界。', conflictStyle: '冲突以误会、暧昧、回避、责任和现实条件不对位为主。', outlineShape: '先相遇或重逢，再制造现实阻碍，最后留下情绪悬念。', toneConstraints: '既要有甜虐张力，也要有现实质感。' },
  豪门: { storyFocus: '主角与权势、婚约、资源或名誉的绑定关系要先讲清。', worldviewBias: '多写家族规则、利益交换、舆论面子和阶层压迫。', conflictStyle: '冲突以控制、误判、权力失衡和感情博弈为主。', outlineShape: '先给身份压力，再放大利益冲突，尾部补一记感情钩子。', toneConstraints: '要华丽但不浮夸，人物算盘必须在线。' },
  穿越: { storyFocus: '先明确穿越后的身份、最大信息差和第一生存目标。', worldviewBias: '世界观重点在新旧认知冲突、时代规则和身份落差。', conflictStyle: '冲突以适应、隐藏、利用知识差和改变命运为主。', outlineShape: '先落地新身份，再触发旧知识与新规则的碰撞。', toneConstraints: '别只靠金手指顺推，要让代价和阻力存在。' },
  宫斗: { storyFocus: '优先明确主角在权力结构中的位置、弱点和想要守住的东西。', worldviewBias: '多写规制、宠势、信息流和后宫/内廷秩序。', conflictStyle: '冲突以算计、试探、站队和失势风险为主。', outlineShape: '先用礼制场景落位人物，再迅速抛出明暗对抗。', toneConstraints: '狠而稳，避免嘴上聪明、行为空心。' },
  种田: { storyFocus: '明确主角想过上什么日子，以及必须解决的现实问题。', worldviewBias: '多写土地、手艺、邻里关系、家计和稳步经营。', conflictStyle: '冲突围绕资源不足、亲族摩擦、外部压榨和生活改善展开。', outlineShape: '先立贫困或困局，再给改善抓手，最后埋下下一轮生活挑战。', toneConstraints: '温度和细节要足，但不能没事发生。' },
  双男主: { storyFocus: '两位核心人物的互补与对抗关系必须从开局就成立。', worldviewBias: '世界观服务关系推进、身份束缚和情绪张力。', conflictStyle: '冲突以立场差、误会、吸引、试探和共同危险为主。', outlineShape: '先建立碰撞，再形成绑定，尾部留关系升级空间。', toneConstraints: '情绪拉扯要准，避免只剩标签化互动。' },
  玄幻: { storyFocus: '主角的成长野心、力量门槛和最先要跨过的阶层障碍要明确。', worldviewBias: '多写体系等级、势力地图、资源争夺和血脉/体质差异。', conflictStyle: '冲突重在强弱秩序、机缘争抢和尊严压迫。', outlineShape: '弱势开局、机缘破口、势力注意，节节推进。', toneConstraints: '爽点可以有，但要靠铺垫而不是硬送。' },
  武侠: { storyFocus: '先明确人物立场、江湖身份和必须出手的理由。', worldviewBias: '世界观聚焦门派恩怨、江湖规矩、地域风貌和名望体系。', conflictStyle: '冲突以恩怨、义利、承诺、仇杀和师承牵引为主。', outlineShape: '从一件江湖事切入，逐步牵出更深旧账或势力冲突。', toneConstraints: '要有侠气和烟火气，别写成纯战斗说明。' },
  官场: { storyFocus: '主角的职位处境、上升目标和当前风险必须清楚。', worldviewBias: '多写制度链条、人情网络、资源分配和话语边界。', conflictStyle: '冲突以站队、博弈、责任甩锅和利益平衡为主。', outlineShape: '先给具体事务，再显露权力结构，最后抛更大考验。', toneConstraints: '克制、锋利，少喊口号，多写局中人算计。' },
  商战: { storyFocus: '先确定主角要抢什么市场、资金或位置，以及短板在哪里。', worldviewBias: '世界观聚焦行业格局、资本压力、谈判桌和资源链。', conflictStyle: '冲突围绕竞争、收购、背刺、现金流和舆论展开。', outlineShape: '先给交易或机会，再暴露阻击，尾部留更大盘面。', toneConstraints: '专业感要有，但核心还是人和利益。' },
  港综: { storyFocus: '主角必须和港岛秩序、灰白边界或经典人物网络产生实质绑定。', worldviewBias: '多写社团、警队、地盘、生意链和时代城市气味。', conflictStyle: '冲突以地盘、人情、规矩、身份切换和黑白博弈为主。', outlineShape: '先用一场够港味的事件立住人，再把主角推入更大局。', toneConstraints: '节奏利落，人物要有算盘，别只复述经典桥段。' },
  谍战: { storyFocus: '优先明确人物身份层、任务目标和暴露代价。', worldviewBias: '多写潜伏环境、情报链、身份伪装和时代高压。', conflictStyle: '冲突以试探、误导、追查、牺牲和信任危机为主。', outlineShape: '先给任务，再埋风险，最后让危险逼近。', toneConstraints: '紧绷、克制，避免角色一张嘴就透底。' },
  军事: { storyFocus: '主角所在体系、任务目标和战场/行动限制要先明确。', worldviewBias: '世界观聚焦指挥链、战术环境、补给与组织协同。', conflictStyle: '冲突以任务压力、地形条件、牺牲决策和团队协作为主。', outlineShape: '先给任务压顶，再暴露难点，最后收在更难的下一步。', toneConstraints: '强调执行感和代价感，避免纯口号式燃。' },
  同人: { storyFocus: '主角切入原作世界的独特位置和对原有剧情的改变潜力必须明确。', worldviewBias: '世界观优先沿用原作核心规则，再补足主角的新变量。', conflictStyle: '冲突围绕熟悉角色、原有事件偏转和新旧命运冲撞展开。', outlineShape: '先借熟悉场景落地，再快速偏转剧情期待。', toneConstraints: '要有原作识别度，但不能只是照着走流程。' }
}

/** 短篇/长篇在大纲、世界观和节奏上的差异化要求 */
const LENGTH_ADJUSTMENTS: Record<NovelLength, { outline: string; world: string; pacing: string }> = {
  long: {
    outline: '三条大纲可偏向长线铺垫：先立局、再升级、最后抛出更大的局势或人物关系钩子。',
    world: '世界观允许保留一条更偏长期伏笔的设定，为后续扩展留口。',
    pacing: '节奏可以舒展，但每条都必须给读者明确的新信息或新压力。'
  },
  short: {
    outline: '三条大纲必须更聚焦单线冲突，尽快推进到核心矛盾，不做宽散铺陈。',
    world: '世界观只保留最关键、最直接影响故事的设定。',
    pacing: '节奏更紧，尽量让每条大纲都带来明确事件推动或情绪拐点。'
  }
}

/**
 * 根据项目题材和篇幅，生成启动 prompt 所需的题材标签、篇幅标签和策略文本块。
 *
 * @param context 项目上下文，需包含 projectGenre 和 projectNovelLength 字段
 * @returns 包含 genreLabel、lengthLabel 和 strategyBlock 的对象
 */
export function resolveProjectBootstrapPromptParts(context: Record<string, unknown>): {
  genreLabel: string
  lengthLabel: string
  strategyBlock: string
} {
  const genreLabel = String(context.projectGenre ?? '').trim() || '未指定'
  const novelLength: NovelLength = context.projectNovelLength === 'short' ? 'short' : 'long'
  const lengthLabel = novelLength === 'short' ? '短篇' : '长篇'
  const strategy = GENRE_STRATEGIES[genreLabel] ?? DEFAULT_STRATEGY
  const lengthAdjustment = LENGTH_ADJUSTMENTS[novelLength]
  const customGenreLine = GENRE_STRATEGIES[genreLabel]
    ? ''
    : `- 自定义题材处理：把"${genreLabel}"视为作品主导题材，所有设定和大纲都必须围绕它展开，而不是退回通用套路。\n`

  return {
    genreLabel,
    lengthLabel,
    strategyBlock: [
      `- 题材聚焦：${strategy.storyFocus}`,
      `- 世界观偏向：${strategy.worldviewBias}`,
      `- 冲突设计：${strategy.conflictStyle}`,
      `- 大纲组织：${strategy.outlineShape}`,
      `- 语气边界：${strategy.toneConstraints}`,
      `- ${lengthLabel}节奏：${lengthAdjustment.pacing}`,
      `- ${lengthLabel}大纲要求：${lengthAdjustment.outline}`,
      `- ${lengthLabel}设定要求：${lengthAdjustment.world}`,
      customGenreLine.trimEnd()
    ].filter(Boolean).join('\n')
  }
}
