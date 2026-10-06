import type { CVData } from "@/types/cv";

/** The CV before anything is written in it. (Apart from firestore.ts: the site's pages read it without loading Firestore.) */
export const DEFAULT_CV_DATA: CVData = {
  myname: "",
  myrole: "",
  profileImage: "",
  aboutParagraphs: [],
  experience: [],
  education: [],
  skillsList: [],
  hobbies: [],
  contact: [],
  cvPdfUrl: "",
  cvPreviewImage: "",
};
