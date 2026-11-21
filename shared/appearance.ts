import { z } from 'zod';

export const appearance = z.enum(['petrol', 'midnight', 'bronze', 'titanium', 'graphite']);
export type Appearance = z.infer<typeof appearance>;
export const appearanceNames: Record<Appearance, string> = {
  petrol: 'Petrol',
  midnight: 'Midnight',
  bronze: 'Smoked Bronze',
  titanium: 'Titanium',
  graphite: 'Graphite',
};
