/**
 * 看板配置字段的动态选项。字段在 FIELDS 里用 optionsFrom 声明数据源名字，
 * 各模块自己注册数据源（工具清单、表情题材、群、人……），配置页和字段定义都不用知道选项从哪来。
 */
export interface FieldOption {
  value: string
  label: string
  /** 选项下面的一行说明 */
  desc?: string
}

const sources = new Map<string, () => FieldOption[]>()

export function registerOptionSource(name: string, source: () => FieldOption[]) {
  sources.set(name, source)
}

export function optionsOf(name: string): FieldOption[] {
  try {
    return sources.get(name)?.() ?? []
  } catch {
    return []
  }
}
