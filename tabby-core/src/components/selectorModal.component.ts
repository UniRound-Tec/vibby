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
        const pageOrders = new Map(this.pageDefinitions.map(page => [page.name, page.order]))
        for (const option of this.options) {
            if (option.page) {
                pageOrders.set(option.page, Math.min(pageOrders.get(option.page) ?? Number.MAX_SAFE_INTEGER, option.pageOrder ?? 0))
            }
        }
        this.pages = [...pageOrders].map(([name, order]) => ({ name, order }))
            .sort((a, b) => a.order - b.order)
        this.activePage = this.pages[0]?.name ?? null
        this.onFilterChange()
        this.hasGroups = this.options.some(x => x.group)
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
        const pageOptions = this.activePage
            ? this.options.filter(option => option.page === this.activePage || option.allPages)
            : this.options
        if (!f) {
            this.filteredOptions = pageOptions.slice().sort(
                firstBy<SelectorOption<T>, number>(x => x.weight ?? 0)
                    .thenBy<SelectorOption<T>, string>(x => x.group ?? '')
                    .thenBy<SelectorOption<T>, string>(x => x.name),
            )
                .filter(x => !x.freeInputPattern)
        } else {
            // eslint-disable-next-line @typescript-eslint/restrict-plus-operands
            this.filteredOptions = new FuzzySearch(
                pageOptions,
                ['name', 'group', 'description'],
                { sort: true },
            ).search(f)

            pageOptions.filter(x => x.freeInputPattern).sort(firstBy<SelectorOption<T>, number>(x => x.weight ?? 0)).forEach(freeOption => {
                if (!this.filteredOptions.includes(freeOption)) {
                    this.filteredOptions.push(freeOption)
                }
            })
        }
        this.selectedIndex = Math.max(0, this.selectedIndex)
        this.selectedIndex = Math.min(this.filteredOptions.length - 1, this.selectedIndex)
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
