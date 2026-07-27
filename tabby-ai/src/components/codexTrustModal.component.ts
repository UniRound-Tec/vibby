import { Component } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'

/**
 * Shown once ever while Codex is launched with hook trust disabled; the
 * adapter records the first display before opening, so it never returns.
 */
/** @hidden */
@Component({
    templateUrl: './codexTrustModal.component.pug',
    styleUrls: ['./codexTrustModal.component.scss'],
})
export class CodexTrustModalComponent {
    constructor (private activeModal: NgbActiveModal) { }

    acknowledge (): void {
        this.activeModal.close()
    }
}
