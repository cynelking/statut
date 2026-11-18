export interface AlphaPayCountry {
  iso_code: string;
  name: string;
  default_currency: string;
}

export interface AlphaPayNetwork {
  code: string;
  name: string;
  country: string;
  is_active: boolean;
}

export const COUNTRY_CODES: Record<string, string> = {
  Togo: 'TG',
  Bénin: 'BJ',
  'Côte d’Ivoire': 'CI',
  Sénégal: 'SN',
  'Burkina Faso': 'BF',
  Mali: 'ML',
  Niger: 'NE',
  Cameroun: 'CM',
  Gabon: 'GA',
  Tchad: 'TD',
  Congo: 'CG',
  'Guinée-Bissau': 'GW',
  'République centrafricaine': 'CF',
  'Guinée équatoriale': 'GQ',
};

export const COUNTRY_CALLING_CODES: Record<string, string> = {
  TG: '228',
  BJ: '229',
  CI: '225',
  SN: '221',
  BF: '226',
  ML: '223',
  NE: '227',
  CM: '237',
  GA: '241',
  TD: '235',
  CG: '242',
  GW: '245',
  CF: '236',
  GQ: '240',
};

export function currencyForCountry(country: string) {
  return ['CM', 'GA', 'TD', 'CG', 'CF', 'GQ'].includes(country) ? 'XAF' : 'XOF';
}
