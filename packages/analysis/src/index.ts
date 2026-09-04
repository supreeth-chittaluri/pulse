export {
  mean,
  stddev,
  zScore,
  standardError,
  countSpreadFloor,
} from './statistics.ts';
export {
  bucketOf,
  selectBaselineWindow,
  computeSentimentBaseline,
  computeVolumeBaseline,
  excludeFixedCadence,
  isFixedCadenceSource,
  DEFAULT_BASELINE_CONFIG,
  HOUR_MS,
  type Observation,
  type BaselineConfig,
  type SentimentBaseline,
  type VolumeBaseline,
} from './baseline.ts';
export {
  detectSpike,
  latestCompleteWindow,
  DEFAULT_DETECTION_CONFIG,
  type DetectionConfig,
  type DetectionInput,
  type DetectionResult,
  type Rejection,
  type Spike,
  type SpikeKind,
} from './detect.ts';
