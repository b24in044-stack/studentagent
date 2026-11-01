export type Role = 'faculty' | 'student';

export type StudentRecord = {
  id: string;
  name: string;
  rollNo: string;
  email?: string;
  attendance?: number;
  marks: Record<string, number>;
};

export type CourseMaterial = {
  id: string;
  name: string;
  type: string;
  subject: string;
  tags: string[];
  source: 'Faculty upload' | 'Demo library';
  excerpt?: string;
  fileId?: string;
  sizeBytes?: number;
  uploadedAt?: string;
};

export type CourseSection = {
  id: string;
  code: string;
  name: string;
  course: string;
  term: string;
  faculty: string;
  facultyEmail: string;
  room: string;
  schedule: string;
  subjects: string[];
  departmentId?: string;
  btechYear?: number;
  semester?: number;
  section?: string;
  students: StudentRecord[];
  materials: CourseMaterial[];
  cohortSummary?: {
    studentCount: number;
    overallAverage?: number;
    subjectAverages: Record<string, number>;
  };
};

export type StudentInsight = {
  overall: number;
  classAverage: number;
  gap: number;
  group: string;
  level: string;
  bestSubject: string;
  bestScore: number;
  weakSubject: string;
  weakScore: number;
  strengths: string[];
  weaknesses: string[];
  recommendation: string;
  attendanceAlert?: string;
};

export type RagMaterial = {
  id: string;
  name: string;
  type: string;
  subject: string;
  tags: string[];
  excerpt?: string;
};

export type LearningContext = {
  course: {
    title: string;
    sectionCode: string;
    sectionName: string;
    term: string;
    facultyName: string;
    facultyEmail?: string;
    room?: string;
    schedule?: string;
  };
  cohort: {
    studentCount: number;
    overallAverage: number;
    subjectAverages: Record<string, number>;
  };
  learner: {
    subjectMarks: Record<string, number>;
    overallAverage: number;
    classGap: number;
    attendance?: number;
    strongestSubject: string;
    focusSubjects: string[];
  };
  retrievedMaterials: RagMaterial[];
};

export type AiFocusArea = {
  subject: string;
  evidence: string;
  action: string;
};

export type AiMaterialSuggestion = {
  materialId: string;
  reason: string;
};

export type AiReview = {
  summary: string;
  strengths: string[];
  focusAreas: AiFocusArea[];
  weeklyPlan: string[];
  recommendedMaterials: AiMaterialSuggestion[];
  facultyFollowUp: string;
  model?: string;
};
