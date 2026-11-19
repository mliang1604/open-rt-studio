/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import type { SeriesSummary } from '../../data-source/data-source';
import { seriesChipLabel } from '../history-panel/series-chip';
import { LayersController } from '../layers-controller';
import { REGISTRATION_NAME_LENGTH } from '../manual-registration/registration-export';
import {
  RegistrationWorkflowController,
  type RegistrationMethod,
} from './registration-workflow-controller';

/** A way of registering, as the panel offers it. */
interface MethodChoice {
  readonly method: RegistrationMethod;
  readonly label: string;
  readonly title: string;
  /** Whether it can be gone here. */
  readonly offered: boolean;
}

/**
 * The registration panel (#82): one flow from two series to a registration
 * that was looked at and kept. It sets nothing itself; the
 * {@link RegistrationWorkflowController} holds the flow.
 *
 * Three things are shown, one at a time: the set-up (which two series, and
 * how), a registration a server is computing, and one that waits to be
 * accepted or discarded.
 */
@Component({
  selector: 'app-registration-workflow',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './registration-workflow.html',
  styleUrls: ['../panel-card.css', './registration-workflow.css'],
})
export class RegistrationWorkflow {
  protected readonly flow = inject(RegistrationWorkflowController);
  protected readonly layers = inject(LayersController);

  protected readonly nameLength = REGISTRATION_NAME_LENGTH;

  protected readonly said = (series: SeriesSummary | null): string =>
    series ? `${series.modality ?? 'Series'} · ${seriesChipLabel(series)}` : 'None chosen';

  /** The ways of registering, each with whether it can be gone here. */
  protected readonly methods = computed<readonly MethodChoice[]>(() => {
    const computing = this.flow.computing();
    const ready = computing.kind === 'ready' ? computing : null;
    return [
      {
        method: 'by-hand',
        label: 'By hand',
        title: 'Shift and turn the moving image yourself, with numbers or by dragging it',
        offered: true,
      },
      {
        method: 'rigid',
        label: 'Automatic, rigid',
        title:
          'Have the server find the shift and the turn that bring the moving image to the fixed one',
        offered: !!ready?.rigid,
      },
      {
        method: 'deformable',
        label: 'Automatic, deformable',
        title:
          'Have the server find a deformation field that brings the moving image to the fixed one',
        offered: !!ready?.deformable,
      },
    ];
  });

  /** Why nothing is computed here, or what is being found out; null when it can be. */
  protected readonly computingSaid = computed<string | null>(() => {
    const computing = this.flow.computing();
    switch (computing.kind) {
      case 'files':
        return 'An automatic registration is computed by an Open RT Studio server that has the registration tools, not by this page. Connect to one with “Server…” on the history bar. In the desktop application the library on this computer is one, for what was imported into it. By hand works here.';
      case 'asking':
        return 'Asking the server what it can compute…';
      case 'unreachable':
        return `The server could not be asked what it can compute. ${computing.why}`;
      case 'none':
        return computing.library
          ? 'The library on this computer has no registration tools: this copy of the application came without them. Connect to a server that has them for an automatic registration. By hand works here.'
          : 'This server has no registration tools, so it computes no registration: whoever runs it sets them up (its nativeTools setting). By hand works here.';
      case 'ready':
        return computing.rigid && !computing.deformable
          ? 'This server has no presets for a deformable registration.'
          : null;
      default: {
        const exhaustive: never = computing;
        return exhaustive;
      }
    }
  });

  protected readonly automatic = computed(() => this.flow.method() !== 'by-hand');

  /** The presets a deformable registration can be run with here. */
  protected readonly presets = computed(() => {
    const computing = this.flow.computing();
    return computing.kind === 'ready' ? computing.presets : [];
  });

  /** How far the registration is, as a percentage; null before the server says. */
  protected readonly percent = computed(() => {
    const progress = this.flow.run()?.job.progress;
    return progress == null ? null : Math.round(progress * 100);
  });

  /** What the registration under way is doing, in a line. */
  protected readonly runSaid = computed(() => {
    const run = this.flow.run();
    if (!run) return '';
    if (run.opening) return 'Done. Opening the two images with the registration…';
    if (run.cancelling) return 'Asking the server to stop…';
    if (run.job.status === 'queued') return `Waiting for its turn ${this.flow.keptWhere()}…`;
    const doing = run.job.message?.trim() || 'Registering';
    const percent = this.percent();
    return percent === null ? `${doing}…` : `${doing} · ${percent}%`;
  });

  protected onMethod(method: RegistrationMethod): void {
    this.flow.method.set(method);
  }

  protected onPreset(event: Event): void {
    this.flow.preset.set((event.target as HTMLSelectElement).value);
  }

  protected onFromScreen(event: Event): void {
    this.flow.fromScreen.set((event.target as HTMLInputElement).checked);
  }
}
