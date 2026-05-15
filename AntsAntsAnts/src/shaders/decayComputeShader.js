export const decayComputeShader = /* wgsl */ `
struct SimParams {
  resolution: vec2<f32>,
  antCount: u32,
  frame: u32,
  sensorDistance: f32,
  sensorAngle: f32,
  turnSpeed: f32,
  moveSpeed: f32,
  trailDeposit: f32,
  crowdDeposit: f32,
  deathDeposit: f32,
  trailDecay: f32,
  trailDiffusion: f32,
  crowdDecay: f32,
  crowdDiffusion: f32,
  deathDecay: f32,
  deathDiffusion: f32,
  minTrailFollow: f32,
  minCrowdAvoid: f32,
  deltaTime: f32,
  anthillPosition: vec2<f32>,
  anthillRadius: f32,
  spawnAngleVariation: f32,
  deathAvoidStrength: f32,
  minDeathAvoid: f32,
  foodTrailDeposit: f32,
  foodTrailFollowStrength: f32,
  homePullStrength: f32,
  foodPickupThreshold: f32,
  foodTrailCarryFullStrengthTime: f32,
  foodTrailCarryFalloff: f32,
  foodTrailMinCarryDepositRatio: f32,
  sensorSize: f32,
  trailAttractionStrength: f32,
  crowdAvoidStrength: f32,
  foodTrailDecay: f32,
  foodTrailDiffusion: f32,
  clearOtherTrails: f32,
};

@group(0) @binding(0) var fieldIn: texture_2d<f32>;
@group(0) @binding(1) var fieldOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> params: SimParams;
@group(0) @binding(3) var foodTrailIn: texture_2d<f32>;

const PHEROMONE_CUTOFF: f32 = 0.035;
const PHEROMONE_LINEAR_DECAY: f32 = 0.025;

fn readField(pixel: vec2<i32>) -> vec4<f32> {
  let maxPixel = vec2<i32>(params.resolution) - vec2<i32>(1, 1);
  return textureLoad(fieldIn, clamp(pixel, vec2<i32>(0, 0), maxPixel), 0);
}

fn readFoodTrail(pixel: vec2<i32>) -> f32 {
  let maxPixel = vec2<i32>(params.resolution) - vec2<i32>(1, 1);
  return textureLoad(foodTrailIn, clamp(pixel, vec2<i32>(0, 0), maxPixel), 0).b;
}

fn fadeToZero(value: f32) -> f32 {
  return select(value, 0.0, value < PHEROMONE_CUTOFF);
}

fn decayPheromone(value: f32, decayRate: f32) -> f32 {
  if (decayRate <= 0.0) {
    return value;
  }

  let decayed = value * max(0.0, 1.0 - decayRate * params.deltaTime);
  let drained = max(0.0, decayed - decayRate * PHEROMONE_LINEAR_DECAY * params.deltaTime);
  return fadeToZero(drained);
}

fn spreadPheromone(center: f32, neighborAverage: f32, diffusion: f32) -> f32 {
  return min(1.0, max(center, neighborAverage * diffusion));
}

fn spreadDeathPheromone(center: f32, neighborAverage: f32) -> f32 {
  return min(1.0, max(center, neighborAverage * params.deathDiffusion));
}

fn clearOtherTrailNearFoodTrail(value: f32, foodTrail: f32) -> f32 {
  let clearAmount = foodTrail * params.clearOtherTrails * params.deltaTime;
  return fadeToZero(max(0.0, value - clearAmount));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let pixel = vec2<i32>(id.xy);
  if (pixel.x >= i32(params.resolution.x) || pixel.y >= i32(params.resolution.y)) {
    return;
  }

  let center = readField(pixel);
  let right = readField(pixel + vec2<i32>(1, 0));
  let left = readField(pixel + vec2<i32>(-1, 0));
  let down = readField(pixel + vec2<i32>(0, 1));
  let up = readField(pixel + vec2<i32>(0, -1));
  let neighbors = right + left + down + up;
  let foodTrailCenter = readFoodTrail(pixel);
  let foodTrailRight = readFoodTrail(pixel + vec2<i32>(1, 0));
  let foodTrailLeft = readFoodTrail(pixel + vec2<i32>(-1, 0));
  let foodTrailDown = readFoodTrail(pixel + vec2<i32>(0, 1));
  let foodTrailUp = readFoodTrail(pixel + vec2<i32>(0, -1));
  let foodTrailInfluence = max(foodTrailCenter, (foodTrailRight + foodTrailLeft + foodTrailDown + foodTrailUp) * 0.25);

  let neighborAverage = neighbors * 0.25;
  let deathCenter = decayPheromone(center.r, params.deathDecay);
  let deathNeighborAverage =
      decayPheromone(right.r, params.deathDecay) +
      decayPheromone(left.r, params.deathDecay) +
      decayPheromone(down.r, params.deathDecay) +
      decayPheromone(up.r, params.deathDecay);
  let death = fadeToZero(spreadDeathPheromone(deathCenter, deathNeighborAverage * 0.25));

  let crowdCenter = decayPheromone(center.g, params.crowdDecay);
  let crowdNeighborAverage =
      decayPheromone(right.g, params.crowdDecay) +
      decayPheromone(left.g, params.crowdDecay) +
      decayPheromone(down.g, params.crowdDecay) +
      decayPheromone(up.g, params.crowdDecay);
  let crowd = clearOtherTrailNearFoodTrail(
      spreadPheromone(crowdCenter, crowdNeighborAverage * 0.25, params.crowdDiffusion),
      foodTrailInfluence
  );

  let trailCenter = decayPheromone(center.b, params.trailDecay);
  let trailNeighborAverage =
      decayPheromone(right.b, params.trailDecay) +
      decayPheromone(left.b, params.trailDecay) +
      decayPheromone(down.b, params.trailDecay) +
      decayPheromone(up.b, params.trailDecay);
  let trail = clearOtherTrailNearFoodTrail(
      spreadPheromone(trailCenter, trailNeighborAverage * 0.25, params.trailDiffusion),
      foodTrailInfluence
  );
  let antPulse = fadeToZero(mix(center.a, neighborAverage.a, params.trailDiffusion) * 0.35);
  let pheromones = vec3<f32>(death, crowd, trail);

  // The alpha channel is only a short-lived visual pulse for ant bodies.
  textureStore(fieldOut, pixel, vec4<f32>(pheromones, antPulse));
}
`;

export const foodTrailDecayComputeShader = /* wgsl */ `
struct SimParams {
  resolution: vec2<f32>,
  antCount: u32,
  frame: u32,
  sensorDistance: f32,
  sensorAngle: f32,
  turnSpeed: f32,
  moveSpeed: f32,
  trailDeposit: f32,
  crowdDeposit: f32,
  deathDeposit: f32,
  trailDecay: f32,
  trailDiffusion: f32,
  crowdDecay: f32,
  crowdDiffusion: f32,
  deathDecay: f32,
  deathDiffusion: f32,
  minTrailFollow: f32,
  minCrowdAvoid: f32,
  deltaTime: f32,
  anthillPosition: vec2<f32>,
  anthillRadius: f32,
  spawnAngleVariation: f32,
  deathAvoidStrength: f32,
  minDeathAvoid: f32,
  foodTrailDeposit: f32,
  foodTrailFollowStrength: f32,
  homePullStrength: f32,
  foodPickupThreshold: f32,
  foodTrailCarryFullStrengthTime: f32,
  foodTrailCarryFalloff: f32,
  foodTrailMinCarryDepositRatio: f32,
  sensorSize: f32,
  trailAttractionStrength: f32,
  crowdAvoidStrength: f32,
  foodTrailDecay: f32,
  foodTrailDiffusion: f32,
  clearOtherTrails: f32,
};

@group(0) @binding(0) var fieldIn: texture_2d<f32>;
@group(0) @binding(1) var fieldOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> params: SimParams;

const PHEROMONE_CUTOFF: f32 = 0.035;
const PHEROMONE_LINEAR_DECAY: f32 = 0.025;

fn readField(pixel: vec2<i32>) -> vec4<f32> {
  let maxPixel = vec2<i32>(params.resolution) - vec2<i32>(1, 1);
  return textureLoad(fieldIn, clamp(pixel, vec2<i32>(0, 0), maxPixel), 0);
}

fn fadeToZero(value: f32) -> f32 {
  return select(value, 0.0, value < PHEROMONE_CUTOFF);
}

fn decayPheromone(value: f32, decayRate: f32) -> f32 {
  if (decayRate <= 0.0) {
    return value;
  }

  let decayed = value * max(0.0, 1.0 - decayRate * params.deltaTime);
  let drained = max(0.0, decayed - decayRate * PHEROMONE_LINEAR_DECAY * params.deltaTime);
  return fadeToZero(drained);
}

fn spreadPheromone(center: f32, neighborAverage: f32, diffusion: f32) -> f32 {
  return min(1.0, max(center, neighborAverage * diffusion));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let pixel = vec2<i32>(id.xy);
  if (pixel.x >= i32(params.resolution.x) || pixel.y >= i32(params.resolution.y)) {
    return;
  }

  let center = readField(pixel);
  let right = readField(pixel + vec2<i32>(1, 0));
  let left = readField(pixel + vec2<i32>(-1, 0));
  let down = readField(pixel + vec2<i32>(0, 1));
  let up = readField(pixel + vec2<i32>(0, -1));
  let neighborAverage = (right + left + down + up) * 0.25;

  let trailCenter = decayPheromone(center.b, params.foodTrailDecay);
  let trailNeighborAverage =
      decayPheromone(right.b, params.foodTrailDecay) +
      decayPheromone(left.b, params.foodTrailDecay) +
      decayPheromone(down.b, params.foodTrailDecay) +
      decayPheromone(up.b, params.foodTrailDecay);
  let trail = fadeToZero(spreadPheromone(trailCenter, trailNeighborAverage * 0.25, params.foodTrailDiffusion));
  let antPulse = fadeToZero(mix(center.a, neighborAverage.a, params.foodTrailDiffusion) * 0.35);

  textureStore(fieldOut, pixel, vec4<f32>(0.0, 0.0, trail, antPulse));
}
`;
