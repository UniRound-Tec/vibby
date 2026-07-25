export interface SelectorPage {
    name: string
    order: number
}

export interface SelectorOption<T> {
    name: string
    description?: string
    group?: string
    /** Optional top-level page. Selectors without pages keep the legacy list. */
    page?: string
    pageOrder?: number
    /** Show this action on every page. */
    allPages?: boolean
    result?: T
    icon?: string
    freeInputPattern?: string
    freeInputEquivalent?: string
    color?: string
    weight?: number
    callback?: (string?) => void
}
