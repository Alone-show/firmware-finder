// 离线冒烟：确认 /firmware 已不再是强制闸门，skill 与工具元信息正确。
import assert from 'node:assert/strict';
import path from 'node:path';
import { apply, __internals } from './index.js';

const { readBundledSkill, SKILL_FILE } = __internals;

const skill = readBundledSkill();
assert.equal(skill.name, 'firmware');
assert.equal(skill.invocation.modelInvocable, true, '模型目录里应能看到 firmware skill');
assert.equal(skill.invocation.userInvocable, true, '`/` 菜单里应能看到 firmware');
assert.equal(skill.source, 'runtime');
assert.equal(skill.path, SKILL_FILE);
assert.equal(skill.resourceBase.path, path.dirname(SKILL_FILE));
assert.ok(skill.content.trimStart().startsWith('# 固件与问题检索'), 'frontmatter 不应进入正文');
assert.ok(skill.content.includes('/firmware'), '正文说明 /firmware 仍可作为显式入口');
assert.ok(!skill.content.includes('只能由用户显式输入'), '不应再强制斜杠');
assert.ok(skill.description.length > 0);
console.log('ok  skill 可被模型/用户调用，且不再强制斜杠');

const tools = [];
let preExecute = 0;
const ctx = {
  get: () => undefined,
  effect: (fn) => {
    fn();
    return () => {};
  },
  on: () => {
    preExecute += 1;
    return () => {};
  },
  tools: {
    register(definition) {
      tools.push(definition);
      return () => {};
    },
  },
  skills: { register: () => () => {} },
};
apply(ctx);

assert.deepEqual(tools.map((t) => t.name).sort(), [
  'firmware_find',
  'firmware_fix_check',
  'firmware_fix_log',
  'firmware_fix_matrix',
  'firmware_fix_models',
  'firmware_fix_sync',
  'firmware_issues',
  'firmware_login',
  'firmware_models',
  'firmware_sync',
]);
console.log('ok  注册 10 个工具');

assert.equal(preExecute, 0, '不应再注册 tools/pre-execute 闸门');
console.log('ok  没有 tools/pre-execute 闸门');

for (const tool of tools) {
  assert.ok(!tool.description.includes('仅当用户输入'), `${tool.name} 描述仍在限制 /firmware`);
  assert.equal(tool.parameters.type, 'object');
  assert.ok(tool.output?.schema, `${tool.name} 缺 output.schema`);
  assert.equal(typeof tool.output.render, 'function', `${tool.name} 缺 output.render`);
}
console.log('ok  工具描述不再要求 /firmware，schema/render 完整');

console.log('\n全部通过');
