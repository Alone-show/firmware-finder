import assert from 'node:assert/strict';
import path from 'node:path';
import { __internals } from './index.js';

const {
  readBundledSkill,
  FIRMWARE_TOOL_NAMES,
  SLASH_FIRMWARE,
  SLASH_ONLY_REASON,
  recentDirectUserMessages,
  slashInvocationOpen,
  SKILL_FILE,
} = __internals;

function userMessage(text, source = 'user') {
  const content = Array.isArray(text)
    ? text.map((part) => ({ type: 'text', text: part }))
    : [{ type: 'text', text }];
  return { type: 'user/message', data: { source: { kind: source }, content } };
}

function otherEvent() {
  return { type: 'agent/step', data: {} };
}

function makeSession(events) {
  return {
    seq: events.length,
    surface: { nodes: events.map((_, index) => index) },
    eventAt: (index) => events[index],
  };
}

function check(name, events, expected) {
  const session = makeSession(events);
  const agent = { session };
  const actual = slashInvocationOpen(agent);
  assert.equal(actual, expected, `${name}: expected ${expected}, got ${actual}`);
  console.log(`ok  ${name}`);
}

// --- 斜杠词边界：与宿主 /firmware 手势一致 ---
check('带参数 /firmware', [userMessage('/firmware spring2pro 安卓')], true);
check('单独的 /firmware', [userMessage('/firmware')], true);
check('行首 /firmware', [userMessage('\n/firmware spring2pro')], true);
check('第二个 text block 里的 /firmware', [userMessage(['先看下这个', '/firmware spring2pro'])], true);
check('自然语言（无斜杠）', [userMessage('帮我找 spring2pro 最新的固件')], false);
check('斜杠粘着中文', [userMessage('用/firmware查一下')], false);
check('斜杠后紧跟中文标点', [userMessage('/firmware，spring2pro')], false);
check('斜杠不是独立词 /firmwarex', [userMessage('/firmwarex spring2pro')], false);
check('斜杠不是独立词 /firmware-finder', [userMessage('/firmware-finder spring2pro')], false);
check('大小写不同 /Firmware', [userMessage('/Firmware spring2pro')], false);
check('反引号包裹的 `/firmware`', [userMessage('执行 `/firmware` 看看')], false);
check('路径里的 /firmware', [userMessage('看下 /opt/firmware/index')], false);

// --- 严格模式：追问轮也必须重新带 /firmware ---
check('追问轮不带 /firmware', [userMessage('/firmware'), userMessage('spring2pro')], false);
check(
  '任务完成后的普通轮次',
  [userMessage('/firmware 昨天'), userMessage('谢谢'), userMessage('再找 apollo')],
  false,
);

// --- 只认 direct user 消息 ---
check('runtime-context 里的 /firmware 不算', [userMessage('/firmware spring2pro', 'runtime-context')], false);
check('较新的非用户事件被跳过', [
  userMessage('/firmware spring2pro'),
  userMessage('汇总', 'skill-invocation'),
], true);

// --- 其它边界 ---
check('只有非 user 事件', [otherEvent()], false);
assert.equal(slashInvocationOpen(undefined), false);
console.log('ok  undefined agent');
assert.equal(slashInvocationOpen({}), false);
console.log('ok  agent without session');
assert.equal(recentDirectUserMessages(makeSession([otherEvent(), userMessage('/firmware')]), 2).length, 1);
console.log('ok  只收集 direct user 消息');

// --- 闸门与 skill 的静态契约 ---
assert.deepEqual(
  [...FIRMWARE_TOOL_NAMES].sort(),
  ['firmware_find', 'firmware_login', 'firmware_models', 'firmware_sync'],
);
console.log('ok  闸门覆盖 4 个固件工具');
assert.equal(SLASH_FIRMWARE.test('/firmware'), true);
assert.equal(SLASH_FIRMWARE.test('用/firmware'), false);
assert.ok(SLASH_ONLY_REASON.includes('/firmware'));
console.log('ok  SLASH_FIRMWARE 与拒绝文案');

const skill = readBundledSkill();
assert.equal(skill.name, 'firmware');
assert.equal(skill.invocation.modelInvocable, false, '模型目录里不应出现 /firmware');
assert.equal(skill.invocation.userInvocable, true, '`/` 菜单里应出现 firmware');
assert.equal(skill.source, 'runtime');
assert.equal(skill.path, SKILL_FILE);
assert.equal(skill.resourceBase.path, path.dirname(SKILL_FILE));
assert.ok(skill.content.trimStart().startsWith('# 固件检索'), 'frontmatter 不应进入正文');
assert.ok(skill.content.includes('/firmware'), '正文必须说明触发方式');
assert.ok(skill.description.includes('/firmware'), '描述要提示用户用 /firmware 触发');
assert.ok(skill.description.length > 0);
console.log('ok  readBundledSkill 元数据与 invocation');

console.log('\n全部通过');
