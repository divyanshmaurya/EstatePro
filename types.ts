
export interface Room {
  id: string;
  name: string;
  size: string;
  description: string;
  features: string[];
}

export interface Property {
  id: string;
  title: string;
  type: 'Villa' | 'Apartment' | 'Penthouse' | 'Mansion';
  location: string;
  price: string;
  beds: number;
  baths: number;
  sqft: number;
  mainImage: string;
  images: string[];
  description: string;
  rooms: Room[];
}

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
}

export enum ChatStage {
  WELCOME = 'WELCOME',
  CORE_NEEDS = 'CORE_NEEDS',
  INTENT_SPECIFIC = 'INTENT_SPECIFIC',
  VALUE_EXCHANGE = 'VALUE_EXCHANGE',
  LEAD_CAPTURE_NAME = 'LEAD_CAPTURE_NAME',
  LEAD_CAPTURE_CONTACT = 'LEAD_CAPTURE_CONTACT',
  HANDOFF = 'HANDOFF',
  COMPLETE = 'COMPLETE'
}

export interface ChatSessionData {
  intent?: 'Buy' | 'Rent' | 'Sell';
  location?: string;
  budget?: string;
  timeline?: string;
  bedrooms?: string;
  financingStatus?: string;
  zipCode?: string;
  listingPreference?: string;
  name?: string;
  phone?: string;
  email?: string;
  contactPreference?: 'Text' | 'Call';
  bestTime?: string;
}

export interface GeminiResponse {
  message: string;
  extractedData?: Partial<ChatSessionData>;
  nextStage?: ChatStage;
  fallback?: boolean;
}
