export const antComputeShader = /* wgsl */ `
struct Ant {
  position: vec2<f32>,
  angle: f32,
  alive: f32,
  foodTrailAge: f32,
  padding0: f32,
  padding1: f32,
  padding2: f32,
};

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

struct SensorReading {
  pheromone: vec4<f32>,
  food: f32,
  foodTrail: vec4<f32>,
};

@group(0) @binding(0) var<storage, read_write> ants: array<Ant>;
@group(0) @binding(1) var fieldIn: texture_2d<f32>;
@group(0) @binding(2) var fieldOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var<uniform> params: SimParams;
@group(0) @binding(4) var deathSpray: texture_2d<f32>;
@group(0) @binding(5) var foodMap: texture_2d<f32>;
@group(0) @binding(6) var foodTrailIn: texture_2d<f32>;
@group(0) @binding(7) var foodTrailOut: texture_storage_2d<rgba16float, write>;

const PHEROMONE_CUTOFF: f32 = 0.035;
const PHEROMONE_LINEAR_DECAY: f32 = 0.025;

fn hash(value: f32) -> f32 {
  return fract(sin(value) * 43758.5453123);
}

fn direction(angle: f32) -> vec2<f32> {
  return vec2<f32>(cos(angle), sin(angle));
}

fn fieldAt(position: vec2<f32>) -> vec4<f32> {
  let maxPixel = vec2<i32>(params.resolution) - vec2<i32>(1, 1);
  let pixel = clamp(vec2<i32>(position), vec2<i32>(0, 0), maxPixel);
  return textureLoad(fieldIn, pixel, 0);
}

fn sprayAt(position: vec2<f32>) -> f32 {
  let maxPixel = vec2<i32>(params.resolution) - vec2<i32>(1, 1);
  let pixel = clamp(vec2<i32>(position), vec2<i32>(0, 0), maxPixel);
  return textureLoad(deathSpray, pixel, 0).r;
}

fn foodAt(position: vec2<f32>) -> f32 {
  let maxPixel = vec2<i32>(params.resolution) - vec2<i32>(1, 1);
  let pixel = clamp(vec2<i32>(position), vec2<i32>(0, 0), maxPixel);
  return textureLoad(foodMap, pixel, 0).r;
}

fn foodTrailAt(position: vec2<f32>) -> vec4<f32> {
  let maxPixel = vec2<i32>(params.resolution) - vec2<i32>(1, 1);
  let pixel = clamp(vec2<i32>(position), vec2<i32>(0, 0), maxPixel);
  return textureLoad(foodTrailIn, pixel, 0);
}

fn fieldPixelAt(pixel: vec2<i32>) -> vec4<f32> {
  let maxPixel = vec2<i32>(params.resolution) - vec2<i32>(1, 1);
  return textureLoad(fieldIn, clamp(pixel, vec2<i32>(0, 0), maxPixel), 0);
}

fn foodTrailPixelAt(pixel: vec2<i32>) -> vec4<f32> {
  let maxPixel = vec2<i32>(params.resolution) - vec2<i32>(1, 1);
  return textureLoad(foodTrailIn, clamp(pixel, vec2<i32>(0, 0), maxPixel), 0);
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

fn decayedFieldAt(position: vec2<f32>) -> vec4<f32> {
  let maxPixel = vec2<i32>(params.resolution) - vec2<i32>(1, 1);
  let pixel = clamp(vec2<i32>(position), vec2<i32>(0, 0), maxPixel);
  let center = fieldPixelAt(pixel);
  let right = fieldPixelAt(pixel + vec2<i32>(1, 0));
  let left = fieldPixelAt(pixel + vec2<i32>(-1, 0));
  let down = fieldPixelAt(pixel + vec2<i32>(0, 1));
  let up = fieldPixelAt(pixel + vec2<i32>(0, -1));
  let foodTrailCenter = foodTrailPixelAt(pixel).b;
  let foodTrailNeighborAverage =
      foodTrailPixelAt(pixel + vec2<i32>(1, 0)).b +
      foodTrailPixelAt(pixel + vec2<i32>(-1, 0)).b +
      foodTrailPixelAt(pixel + vec2<i32>(0, 1)).b +
      foodTrailPixelAt(pixel + vec2<i32>(0, -1)).b;
  let foodTrailInfluence = max(foodTrailCenter, foodTrailNeighborAverage * 0.25);
  let neighborAverage = (right + left + down + up) * 0.25;

  let deathNeighborAverage =
      decayPheromone(right.r, params.deathDecay) +
      decayPheromone(left.r, params.deathDecay) +
      decayPheromone(down.r, params.deathDecay) +
      decayPheromone(up.r, params.deathDecay);
  let crowdNeighborAverage =
      decayPheromone(right.g, params.crowdDecay) +
      decayPheromone(left.g, params.crowdDecay) +
      decayPheromone(down.g, params.crowdDecay) +
      decayPheromone(up.g, params.crowdDecay);
  let trailNeighborAverage =
      decayPheromone(right.b, params.trailDecay) +
      decayPheromone(left.b, params.trailDecay) +
      decayPheromone(down.b, params.trailDecay) +
      decayPheromone(up.b, params.trailDecay);

  let death = fadeToZero(spreadDeathPheromone(
      decayPheromone(center.r, params.deathDecay),
      deathNeighborAverage * 0.25
  ));
  let crowd = clearOtherTrailNearFoodTrail(spreadPheromone(
      decayPheromone(center.g, params.crowdDecay),
      crowdNeighborAverage * 0.25,
      params.crowdDiffusion
  ), foodTrailInfluence);
  let trail = clearOtherTrailNearFoodTrail(spreadPheromone(
      decayPheromone(center.b, params.trailDecay),
      trailNeighborAverage * 0.25,
      params.trailDiffusion
  ), foodTrailInfluence);
  let antPulse = fadeToZero(mix(center.a, neighborAverage.a, params.trailDiffusion) * 0.35);
  return vec4<f32>(death, crowd, trail, antPulse);
}

fn decayedFoodTrailAt(position: vec2<f32>) -> vec4<f32> {
  let maxPixel = vec2<i32>(params.resolution) - vec2<i32>(1, 1);
  let pixel = clamp(vec2<i32>(position), vec2<i32>(0, 0), maxPixel);
  let center = foodTrailPixelAt(pixel);
  let right = foodTrailPixelAt(pixel + vec2<i32>(1, 0));
  let left = foodTrailPixelAt(pixel + vec2<i32>(-1, 0));
  let down = foodTrailPixelAt(pixel + vec2<i32>(0, 1));
  let up = foodTrailPixelAt(pixel + vec2<i32>(0, -1));
  let neighborAverage = (right + left + down + up) * 0.25;
  let trailNeighborAverage =
      decayPheromone(right.b, params.foodTrailDecay) +
      decayPheromone(left.b, params.foodTrailDecay) +
      decayPheromone(down.b, params.foodTrailDecay) +
      decayPheromone(up.b, params.foodTrailDecay);
  let trail = fadeToZero(spreadPheromone(
      decayPheromone(center.b, params.foodTrailDecay),
      trailNeighborAverage * 0.25,
      params.foodTrailDiffusion
  ));
  let antPulse = fadeToZero(mix(center.a, neighborAverage.a, params.foodTrailDiffusion) * 0.35);
  return vec4<f32>(0.0, 0.0, trail, antPulse);
}

fn sensorReadingAt(position: vec2<f32>) -> SensorReading {
  let sensorSize = clamp(i32(params.sensorSize), 1, 5);
  let radius = sensorSize / 2;
  var pheromone = vec4<f32>(0.0);
  var food = 0.0;
  var foodTrail = vec4<f32>(0.0);
  var sampleCount = 0.0;

  for (var y = -2; y <= 2; y += 1) {
    for (var x = -2; x <= 2; x += 1) {
      if (abs(x) <= radius && abs(y) <= radius) {
        let samplePosition = position + vec2<f32>(f32(x), f32(y));
        pheromone += fieldAt(samplePosition);
        food += foodAt(samplePosition);
        foodTrail += foodTrailAt(samplePosition);
        sampleCount += 1.0;
      }
    }
  }

  var reading: SensorReading;
  reading.pheromone = pheromone / sampleCount;
  reading.food = food / sampleCount;
  reading.foodTrail = foodTrail / sampleCount;
  return reading;
}

fn sensorScore(position: vec2<f32>, angle: f32, hasFood: bool) -> f32 {
  let samplePosition = position + direction(angle) * params.sensorDistance;
  let reading = sensorReadingAt(samplePosition);
  let pheromone = reading.pheromone;
  let foodSignal = reading.food;
  let foodTrailSignal = reading.foodTrail.b;
  let trailSignal = select(0.0, pheromone.b, pheromone.b >= params.minTrailFollow);
  let foodTrailPull = select(0.0, foodTrailSignal, foodTrailSignal >= params.minTrailFollow);
  let trailPull = select(
      trailSignal * params.trailAttractionStrength + foodTrailPull * params.foodTrailFollowStrength + foodSignal * 2.0,
      0.0,
      hasFood
  );
  let crowdPush = select(0.0, pheromone.g * params.crowdAvoidStrength, pheromone.g >= params.minCrowdAvoid);
  let deathPush = select(0.0, pheromone.r * params.deathAvoidStrength, pheromone.r >= params.minDeathAvoid);
  return trailPull - crowdPush - deathPush;
}

fn respawnAnt(antIndex: u32) -> Ant {
  let seed = f32(antIndex) * 41.0 + f32(params.frame) * 0.73;
  let spawnAngle = hash(seed) * 6.28318530718;
  let spawnRadius = sqrt(hash(seed + 19.0)) * params.anthillRadius;

  var ant: Ant;
  ant.position = params.anthillPosition + direction(spawnAngle) * spawnRadius;
  ant.angle = 3.14159265359 + (hash(seed + 31.0) - 0.5) * params.spawnAngleVariation;
  ant.alive = 1.0;
  ant.foodTrailAge = 0.0;
  ant.padding0 = 0.0;
  ant.padding1 = 0.0;
  ant.padding2 = 0.0;
  return ant;
}

fn foodTrailDepositMultiplier(age: f32) -> f32 {
  let fadeAge = max(0.0, age - params.foodTrailCarryFullStrengthTime);
  let faded = exp(-fadeAge * params.foodTrailCarryFalloff);
  return max(params.foodTrailMinCarryDepositRatio, faded);
}

@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let antIndex = id.x;
  if (antIndex >= params.antCount || ants[antIndex].alive < 0.5) {
    return;
  }

  var ant = ants[antIndex];
  let hasFood = ant.alive > 1.5;
  let forward = sensorScore(ant.position, ant.angle, hasFood);
  let left = sensorScore(ant.position, ant.angle - params.sensorAngle, hasFood);
  let right = sensorScore(ant.position, ant.angle + params.sensorAngle, hasFood);
  let sensorStrength = max(forward, max(left, right));
  let jitter = (hash(f32(antIndex) * 17.0 + f32(params.frame)) - 0.5) * 0.12;

  if (hasFood) {
    let toHome = params.anthillPosition - ant.position;
    let targetAngle = atan2(toHome.y, toHome.x);
    let turn = atan2(sin(targetAngle - ant.angle), cos(targetAngle - ant.angle));
    let maxHomeTurn = params.turnSpeed * params.homePullStrength * params.deltaTime;
    ant.angle += clamp(turn, -maxHomeTurn, maxHomeTurn);
    if (left > forward && left > right) {
      ant.angle -= params.turnSpeed * params.deltaTime;
    } else if (right > forward && right > left) {
      ant.angle += params.turnSpeed * params.deltaTime;
    }
  } else if (left > forward && left > right) {
    ant.angle -= params.turnSpeed * params.deltaTime;
  } else if (right > forward && right > left) {
    ant.angle += params.turnSpeed * params.deltaTime;
  } else if (sensorStrength <= 0.0) {
    ant.angle += jitter;
  }

  let nextPosition = ant.position + direction(ant.angle) * params.moveSpeed * params.deltaTime;
  let maxPosition = params.resolution - vec2<f32>(1.0, 1.0);
  let lastPixel = vec2<i32>(clamp(ant.position, vec2<f32>(0.0, 0.0), maxPosition));

  if (
    nextPosition.x < 0.0 ||
    nextPosition.y < 0.0 ||
    nextPosition.x >= params.resolution.x ||
    nextPosition.y >= params.resolution.y
  ) {
    let base = decayedFieldAt(ant.position);
    textureStore(fieldOut, lastPixel, max(base, vec4<f32>(params.deathDeposit, 0.0, 0.0, 0.0)));
    ants[antIndex] = respawnAnt(antIndex);
    return;
  }

  if (sprayAt(nextPosition) > 0.15) {
    let sprayPixel = vec2<i32>(nextPosition);
    let base = decayedFieldAt(nextPosition);
    textureStore(fieldOut, sprayPixel, max(base, vec4<f32>(params.deathDeposit, 0.0, 0.0, 0.0)));
    ants[antIndex] = respawnAnt(antIndex);
    return;
  }

  if (!hasFood && foodAt(nextPosition) > params.foodPickupThreshold) {
    ant.alive = 2.0;
    ant.foodTrailAge = 0.0;
    ant.angle += 3.14159265359;
  }

  if (hasFood) {
    ant.foodTrailAge += params.deltaTime;
  }

  if (hasFood && distance(nextPosition, params.anthillPosition) <= params.anthillRadius) {
    ant.alive = 1.0;
    ant.foodTrailAge = 0.0;
    ant.angle += 3.14159265359;
  }

  ant.position = nextPosition;
  ants[antIndex] = ant;

  let pixel = vec2<i32>(nextPosition);
  let base = decayedFieldAt(nextPosition);
  let carriedFood = ant.alive > 1.5;
  let antPulse = select(1.0, 0.0, carriedFood);
  textureStore(
      fieldOut,
      pixel,
      vec4<f32>(
          base.r,
          min(1.0, base.g + params.crowdDeposit),
          min(1.0, base.b + params.trailDeposit),
          max(base.a, antPulse)
      )
  );

  if (carriedFood) {
    let foodTrailBase = decayedFoodTrailAt(nextPosition);
    let trailStrength = params.foodTrailDeposit * foodTrailDepositMultiplier(ant.foodTrailAge);
    textureStore(
        foodTrailOut,
        pixel,
        vec4<f32>(0.0, 0.0, min(1.0, foodTrailBase.b + trailStrength), max(foodTrailBase.a, 1.0))
    );
  }
}
`;
