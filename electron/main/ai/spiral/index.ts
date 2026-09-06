/** 螺旋引导模块入口：统一导出运行函数与所有相关类型 */
export { runSpiralBootstrap } from './pipeline'
export type { SpiralBootstrapInput, SpiralProgressCallback } from './pipeline'
export type {
  SpiralSeedResult,
  SpiralExpandResult,
  SpiralValidateResult,
  SpiralBootstrapResult,
  SpiralProgressEvent,
  SpiralPhase
} from './types'
