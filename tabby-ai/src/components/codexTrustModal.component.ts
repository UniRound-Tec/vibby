import { Component } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'

/**
 * Shown once per run while Codex is launched with hook trust disabled.
 *
 * Closing resolves to whether the notice should stay dismissed; dismissing it
 * with Escape or the backdrop counts as "not now" and it returns next run.
 */
/** @hidden */
@Component({
    templateUrl: './codexTrustModal.component.pug',
    styleUrls: ['./codexTrustModal.component.scss'],
})
export class CodexTrustModalComponent {
    constructor (private activeModal: NgbActiveModal) { }

    acknowledge (): void {
        this.activeModal.close(false)
    }

    silence (): void {
        this.activeModal.close(true)
    }
}
