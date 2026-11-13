import type { AgentOutput, RunnerInput } from '../../shared/types.js';

/** No processes, timers, network calls or host writes: this is explicitly a simulation. */
export async function runFake(input: RunnerInput): Promise<AgentOutput> {
  if (input.signal.aborted) throw new Error('Simulation cancelled');
  switch (input.stage) {
    case 'planning':
      return {
        summary: '[SIMULATION · 模拟规划] 规划一个无外部依赖的 add(a, b) 实现；未调用真实 AI。',
        files: [],
        acceptanceCriteria: [
          'src/add.mjs 导出 add(a, b)，支持两个有限数字相加，覆盖零、负数和小数。',
          '非数字或非有限数字输入应抛出 TypeError。',
          '独立 tests/*.test.mjs 覆盖导出函数；真实验收仍需隔离 Docker 测试。',
        ],
      };
    case 'development':
      return {
        summary: '[SIMULATION · 模拟开发] 返回加法函数的代码变更，由服务端校验后保存；此模拟器未执行项目代码。',
        learningProposals: [{
          title: '数值输入边界检查（演练经验）',
          purpose: '演示如何把开发观察整理成待审核知识，不代表真实运行验证。',
          conditions: '仅适用于本轮无外部依赖的加法演示项目。',
          steps: ['先检查两个输入均为 number。', '再用 Number.isFinite 排除 NaN 与无穷值。', '把异常输入和边界值交给独立 QA 设计测试。'],
          cautions: ['这是模拟提案，不可作为生产验证或权限授予依据。'],
          verification: '应在隔离容器中运行独立测试，保留退出码与代码哈希；当前未执行。',
          tags: ['输入校验', '演练'],
        }],
        files: [{
          path: 'src/add.mjs',
          content: "export function add(a, b) {\n  if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) {\n    throw new TypeError('add requires two finite numbers');\n  }\n  return a + b;\n}\n",
        }],
      };
    case 'qa': {
      const failed = input.task.goal.includes('模拟失败');
      return {
        summary: failed
          ? '[SIMULATION · 模拟验收] 按要求模拟失败；未运行宿主或容器测试。'
          : '[SIMULATION · 模拟验收] 返回独立测试文件；结论仅用于演练，不是真实测试结果。',
        verdict: failed ? 'failed' : 'passed',
        files: [{
          path: 'tests/add.test.mjs',
          content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/add.mjs';\n\ntest('adds positive, negative, zero and fractional numbers', () => {\n  assert.equal(add(2, 3), 5);\n  assert.equal(add(-4, 3), -1);\n  assert.equal(add(0, 0), 0);\n  assert.equal(add(0.25, 0.5), 0.75);\n});\n\ntest('rejects invalid operands', () => {\n  for (const invalid of ['2', null, undefined, NaN, Infinity, -Infinity]) {\n    assert.throws(() => add(invalid, 1), TypeError);\n    assert.throws(() => add(1, invalid), TypeError);\n  }\n});\n"
            + (failed ? "\ntest('explicit simulated failure', () => {\n  assert.fail('模拟失败');\n});\n" : ''),
        }],
      };
    }
    case 'ops':
      return { summary: '[SIMULATION · 模拟运维] 仅演示观察报告；没有执行部署、发布、监控探针或生产操作。', files: [] };
    default:
      throw new Error('Unknown simulation stage');
  }
}
