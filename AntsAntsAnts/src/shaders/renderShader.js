export const renderShader = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct RenderParams {
  deathIntensity: f32,
  poisonIntensity: f32,
  crowdIntensity: f32,
  trailIntensity: f32,
  foodIntensity: f32,
  foodTrailIntensity: f32,
  antsWithoutFoodIntensity: f32,
  antsWithFoodIntensity: f32,
};

@group(0) @binding(0) var fieldSampler: sampler;
@group(0) @binding(1) var fieldTexture: texture_2d<f32>;
@group(0) @binding(2) var deathSpray: texture_2d<f32>;
@group(0) @binding(3) var foodMap: texture_2d<f32>;
@group(0) @binding(4) var<uniform> renderParams: RenderParams;
@group(0) @binding(5) var foodTrailTexture: texture_2d<f32>;

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  let positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0)
  );

  var output: VertexOutput;
  output.position = vec4<f32>(positions[vertexIndex], 0.0, 1.0);
  output.uv = output.position.xy * 0.5 + vec2<f32>(0.5, 0.5);
  output.uv.y = 1.0 - output.uv.y;
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let field = textureSample(fieldTexture, fieldSampler, input.uv);
  let spray = textureSample(deathSpray, fieldSampler, input.uv).r;
  let foodSignal = textureSample(foodMap, fieldSampler, input.uv).r;
  let foodTrailSignal = textureSample(foodTrailTexture, fieldSampler, input.uv).b;
  let antWithFoodSignal = textureSample(foodTrailTexture, fieldSampler, input.uv).a;
  let deathSignal = pow(field.r, 0.55);
  let poisonSignal = pow(spray, 0.55);
  let foodTrailDisplay = pow(foodTrailSignal, 0.55);
  let death = vec3<f32>(1.35, 0.06, 0.03) * deathSignal * renderParams.deathIntensity;
  let poison = vec3<f32>(0.62, 1.35, 0.04) * poisonSignal * renderParams.poisonIntensity;
  let food = vec3<f32>(1.0, 1.0, 1.0) * foodSignal * renderParams.foodIntensity;
  let foodTrail = vec3<f32>(1.0, 0.36, 0.96) * foodTrailDisplay * renderParams.foodTrailIntensity;
  let crowd = vec3<f32>(0.0, 0.95, 0.4) * field.g * renderParams.crowdIntensity;
  let trail = vec3<f32>(0.18, 0.35, 1.0) * field.b * renderParams.trailIntensity;
  let antsWithoutFood = vec3<f32>(1.0, 0.86, 0.32) * field.a * renderParams.antsWithoutFoodIntensity;
  let antsWithFood = vec3<f32>(1.0, 0.54, 0.12) * antWithFoodSignal * renderParams.antsWithFoodIntensity;
  let color = pow(clamp(food + foodTrail + death + poison + crowd + trail + antsWithoutFood + antsWithFood, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(0.82));
  return vec4<f32>(color, 1.0);
}
`;
