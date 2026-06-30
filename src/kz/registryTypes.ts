export interface GoszakupRegistryRecord {
  bin: string;
  participant_id: string | null;
  name_ru: string | null;
  name_kz: string | null;
  rnn: string | null;
  role: string | null;
  residency: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  registration_date: string | null;
  last_update_date: string | null;
  kopf: string | null;
  ownership_form: string | null;
  economic_sector: string | null;
  director_name: string | null;
  director_iin: string | null;
  legal_address: string | null;
  location_address: string | null;
  full_address_ru: string | null;
  reporting_administrator: string | null;
  registry_url: string | null;
  updated_at: string;
  raw_snapshot_path: string | null;
}
