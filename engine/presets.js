/**
 * 工作流模板（GUI「新建工作流」用）：空白图 = 一个 env 节点起步。
 */

/**
 * @param {string} name
 * @param {string} [title]
 * @returns {any}
 */
export function blankWorkflow(name, title) {
    return {
        name,
        title: title || name,
        version: 1,
        nodes: [
            { id: "env1", type: "env.file", position: [80, 200], data: { envFile: `${name}.env`, schema: {} } },
            { id: "ssh1", type: "ssh.session", position: [340, 200], data: {} },
        ],
        edges: [
            { id: "e1", source: "env1", sourceHandle: "env", target: "ssh1", targetHandle: "env" },
        ],
        tasks: {},
    };
}
