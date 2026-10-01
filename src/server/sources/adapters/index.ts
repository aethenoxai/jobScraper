import { web } from '../../discovery/web';
import { registerAdapter } from '../registry';
import { adzuna } from './adzuna';
import { arbeitnow } from './arbeitnow';
import { ashby } from './ashby';
import { greenhouse } from './greenhouse';
import { himalayas } from './himalayas';
import { lever } from './lever';
import { recruitee } from './recruitee';
import { remoteok } from './remoteok';
import { remotive } from './remotive';
import { smartrecruiters } from './smartrecruiters';
import { workable } from './workable';

import { manual } from './manual';

export const BUILT_IN_ADAPTERS = [manual, greenhouse, lever, ashby, workable, recruitee, smartrecruiters, remoteok, remotive, arbeitnow, himalayas, adzuna, web];

export function registerBuiltInAdapters(): void {
  for (const a of BUILT_IN_ADAPTERS) registerAdapter(a);
}
