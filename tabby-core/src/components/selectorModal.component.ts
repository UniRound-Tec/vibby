import { firstBy } from 'thenby'
import { Component, Input, HostListener, ViewChildren, QueryList, ElementRef } from '@angular/core' // eslint-disable-line @typescript-eslint/no-unused-vars
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import FuzzySearch from 'fuzzy-search'
import { SelectorOption, SelectorPage } from '../api/selector'

/** @hidden */
@Component({
    selector: 'selector-modal',
    templateUrl: './selectorModal.component.pug',
    styleUrls: ['./selectorModal.component.scss'],
})
export class SelectorModalComponent<T> {
    @Input() options: SelectorOption<T>[]
    @Input() filteredOptions: SelectorOption<T>[]
    @Input() filter = ''
    @Input() name: string
    @Input() selectedIndex = 0
    @Input() pageDefinitions: SelectorPage[] = []
    hasGroups = false
    pages: SelectorPage[] = []
    activePage: string|null = null
    @ViewChildren('item') itemChildren: QueryList<ElementRef>
    private preventEdit: boolean

    constructor (public modalInstance: NgbActiveModal) {
        this.preventEdit = false
    }

    ngOnInit (): void {
        // Only pages something actually landed on. A fixed list would show
        // e.g. an empty "Hardware" page to everyone without a serial device,
        // and could open the selector on a page with nothing in it.
        // `allPages` options ride along on every page and so cannot fill one.
        const pageOrders = new Map<string, number>()
        const declaredOrder = new Map(this.pageDefinitions.map(page => [page.name, page.order]))
        for (const option of this.options) {
            if (!option.page || option.allPages) {
                continue
            }
            const order = declaredOrder.get(option.page) ?? option.pageOrder ?? Number.MAX_SAFE_INTEGER
            pageOrders.set(option.page, Math.min(pageOrders.get(option.page) ?? Number.MAX_SAFE_INTEGER, order))
        }
        this.pages = [...pageOrders].map(([name, order]) => ({ name, order }))
            .sort((a, b) => a.order - b.order)
        this.activePage = this.pages[0]?.name ?? null
        this.onFilterChange()
    }

    /** Typing searches every page — the page bar only scopes browsing */
    get searching (): boolean {
        return !!this.filter.trim()
    }

    @HostListener('keydown', ['$event']) onKeyDown (event: KeyboardEvent): void {
        if (event.key === 'Escape') {
            this.close()
        } else if (this.pages.length && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && event.altKey) {
            const direction = event.key === 'ArrowRight' ? 1 : -1
            const current = this.pages.findIndex(page => page.name === this.activePage)
            const target = (current + direction + this.pages.length) % this.pages.length
            this.selectPage(this.pages[target].name)
            event.preventDefault()
        } else if (this.filteredOptions.length > 0) {
            if (event.key === 'PageUp' || event.key === 'ArrowUp' && event.metaKey) {
                this.selectedIndex -= Math.min(10, Math.max(1, this.selectedIndex))
                event.preventDefault()
            } else if (event.key === 'PageDown' || event.key === 'ArrowDown' && event.metaKey) {
                this.selectedIndex += Math.min(10, Math.max(1, this.filteredOptions.length - this.selectedIndex - 1))
                event.preventDefault()
            } else if (event.key === 'ArrowUp') {
                this.selectedIndex--
                event.preventDefault()
            } else if (event.key === 'ArrowDown') {
                this.selectedIndex++
                event.preventDefault()
            } else if (event.key === 'Enter') {
                this.selectOption(this.filteredOptions[this.selectedIndex])
            } else if (event.key === 'Backspace' && !this.preventEdit) {
                if (this.canEditSelected()) {
                    event.preventDefault()
                    this.filter = this.filteredOptions[this.selectedIndex].freeInputEquivalent!
                    this.onFilterChange()
                } else {
                    this.preventEdit = true
                }
            }

            this.selectedIndex = (this.selectedIndex + this.filteredOptions.length) % this.filteredOptions.length

            Array.from(this.itemChildren)[this.selectedIndex]?.nativeElement.scrollIntoView({
                behavior: 'smooth',
                block: 'nearest',
            })
        }
    }

    @HostListener('keyup', ['$event']) onKeyUp (event: KeyboardEvent): void {
        if (event.key === 'Backspace' && this.preventEdit) {
            this.preventEdit = false
        }
    }

    onFilterChange (): void {
        const f = this.filter.trim().toLowerCase()
        // Browsing is scoped to the active page; searching is not. This is the
        // one box you type a host name into, and it would be useless if the
        // answer depended on which page you happened to be standing on.
        const scope = f || !this.activePage
            ? this.options
            : this.options.filter(option => option.page === this.activePage || option.allPages)
        if (!f) {
            this.filteredOptions = scope.slice().sort(
                firstBy<SelectorOption<T>, number>(x => x.weight ?? 0)
                    .thenBy<SelectorOption<T>, string>(x => x.group ?? '')
                    .thenBy<SelectorOption<T>, string>(x => x.name),
            )
                .filter(x => !x.freeInputPattern)
        } else {
            // eslint-disable-next-line @typescript-eslint/restrict-plus-operands
            this.filteredOptions = new FuzzySearch(
                scope,
                ['name', 'group', 'page', 'description'],
                { sort: true },
            ).search(f)

            scope.filter(x => x.freeInputPattern).sort(firstBy<SelectorOption<T>, number>(x => x.weight ?? 0)).forEach(freeOption => {
                if (!this.filteredOptions.includes(freeOption)) {
                    this.filteredOptions.push(freeOption)
                }
            })
        }
        // Searching always labels its results — the user has left the page
        // context, so where a hit came from is the thing they need to know.
        // Browsing only labels when the list spans more than one heading:
        // otherwise it would repeat what the highlighted page button says.
        // Options with no heading at all (Manage profiles) do not count.
        const headings = this.filteredOptions.map(x => this.headingFor(x)).filter(x => x)
        this.hasGroups = this.searching ? headings.length > 0 : new Set(headings).size > 1
        this.selectedIndex = Math.max(0, this.selectedIndex)
        this.selectedIndex = Math.min(this.filteredOptions.length - 1, this.selectedIndex)
    }

    /** Group heading for an option. Tolerates the [i-1] lookup at index 0. */
    headingFor (option: SelectorOption<T>|undefined): string {
        return option ? option.group ?? option.page ?? '' : ''
    }

    selectPage (page: string): void {
        if (this.activePage === page) {
            return
        }
        this.activePage = page
        this.selectedIndex = 0
        this.onFilterChange()
    }

    filterMatches (option: SelectorOption<T>, terms: string[]): boolean {
        const content = (option.group ?? '') + option.name + (option.description ?? '')
        return terms.every(term => content.toLowerCase().includes(term))
    }

    getOptionText (option: SelectorOption<T>): string {
        if (option.freeInputPattern) {
            return option.freeInputPattern.replace('%s', this.filter)
        }
        return option.name
    }

    selectOption (option: SelectorOption<T>): void {
        this.modalInstance.close(option.result)
        setTimeout(() => option.callback?.(this.filter))
    }

    canEditSelected (): boolean {
        return !this.filter && !!this.filteredOptions[this.selectedIndex].freeInputEquivalent && this.options.some(x => x.freeInputPattern)
    }

    close (): void {
        this.modalInstance.dismiss()
    }
}
