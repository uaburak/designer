export interface CVExperience {
  id: string;
  year: string;
  company: string;
  role: string;
  description: string;
}

export interface CVEducation {
  id: string;
  year: string;
  institution: string;
  degree: string;
  description: string;
}

export interface CVSkill {
  id: string;
  name: string;
  level: number;
  iconType: string;
}

export interface CVContact {
  id: string;
  label: string;
  value: string;
  href: string;
}

export interface CVData {
  myname: string;
  myrole: string;
  profileImage: string;
  aboutParagraphs: string[];
  experience: CVExperience[];
  education: CVEducation[];
  skillsList: CVSkill[];
  hobbies: string[];
  contact: CVContact[];
  cvPdfUrl: string;
  cvPreviewImage?: string;
}
