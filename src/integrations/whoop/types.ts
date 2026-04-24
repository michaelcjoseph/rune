/** Whoop API response types and internal data format */

// --- API Response Types ---

export interface WhoopSleepResponse {
  records: WhoopSleep[];
  next_token?: string;
}

export interface WhoopSleep {
  id: string;
  user_id: number;
  created_at: string;
  updated_at: string;
  start: string;
  end: string;
  timezone_offset: string;
  nap: boolean;
  score_state: string;
  score: {
    stage_summary: {
      total_in_bed_time_milli: number;
      total_awake_time_milli: number;
      total_no_data_time_milli: number;
      total_light_sleep_time_milli: number;
      total_slow_wave_sleep_time_milli: number;
      total_rem_sleep_time_milli: number;
      sleep_cycle_count: number;
      disturbance_count: number;
    };
    sleep_needed: { baseline_milli: number; need_from_sleep_debt_milli: number; need_from_recent_strain_milli: number; need_from_recent_nap_milli: number; };
    respiratory_rate: number;
    sleep_performance_percentage: number;
    sleep_consistency_percentage: number;
    sleep_efficiency_percentage: number;
  };
}

export interface WhoopRecoveryResponse {
  records: WhoopRecoveryRecord[];
  next_token?: string;
}

export interface WhoopRecoveryRecord {
  cycle_id: number;
  sleep_id: string;
  user_id: number;
  created_at: string;
  updated_at: string;
  score_state: string;
  score: {
    user_calibrating: boolean;
    recovery_score: number;
    resting_heart_rate: number;
    hrv_rmssd_milli: number;
    spo2_percentage: number;
    skin_temp_celsius: number;
  };
}

export interface WhoopCycleResponse {
  records: WhoopCycle[];
  next_token?: string;
}

export interface WhoopCycle {
  id: number;
  user_id: number;
  created_at: string;
  updated_at: string;
  start: string;
  end: string;
  timezone_offset: string;
  score_state: string;
  score: {
    strain: number;
    kilojoule: number;
    average_heart_rate: number;
    max_heart_rate: number;
  };
}

export interface WhoopWorkoutResponse {
  records: WhoopWorkout[];
  next_token?: string;
}

export interface WhoopWorkout {
  id: string;
  user_id: number;
  created_at: string;
  updated_at: string;
  start: string;
  end: string;
  timezone_offset: string;
  sport_name: string;
  score_state: string;
  score: {
    strain: number;
    average_heart_rate: number;
    max_heart_rate: number;
    kilojoule: number;
    percent_recorded: number;
    zone_durations: { zone_zero_milli: number; zone_one_milli: number; zone_two_milli: number; zone_three_milli: number; zone_four_milli: number; zone_five_milli: number; };
  };
}

// --- Internal Data Types (written to vault) ---

export interface WhoopDailyData {
  date: string;
  sleep?: {
    duration_hours: number;
    performance: number;
    efficiency: number;
    rem_pct: number;
    deep_pct: number;
    respiratory_rate: number;
    disturbances: number;
  };
  recovery?: {
    score: number;
    hrv: number;
    resting_hr: number;
    spo2: number;
  };
  strain?: {
    score: number;
    calories: number;
    avg_hr: number;
    max_hr: number;
  };
  workouts?: {
    sport_name: string;
    duration_min: number;
    strain: number;
    calories: number;
    avg_hr: number;
    max_hr: number;
  }[];
}

// --- Token Types ---

export interface WhoopTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix timestamp in ms
}

export interface WhoopTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  token_type: string;
  scope: string;
}
