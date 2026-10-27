BEGIN;
-- Plan row SD12, the routine part: Schedule@1 and the shop's zone (ADR-0043 items 7, 8 and 9's
-- recurring schedules; docs/briefs/sd12-schedules-shop-zone.md). Executes AS morrow_work_owner.
-- Forward only; no published migration is edited. On the ADR-0010 tenant pattern: composite
-- tenant keys, ENABLE and FORCE RLS, definers owned by morrow_work_command, INVOKER triggers and
-- checks owned by the owner. No external effect: nothing here sends a request, reserves
-- credits, admits a run or writes to a store. It adds:
--   * the closed IANA zone list (iana_time_zones, time_zone_canonical), the SQL twin of
--     packages/contracts/src/time-zones.ts, and Schedule@1's checks (schedule_body_valid), the
--     twin of packages/work/src/schedules/schedule.ts;
--   * the slot arithmetic in SQL, which is the authority on when a schedule fires
--     (schedule_offset_minutes, schedule_resolve_local, schedule_day_slots, schedule_next_slot,
--     schedule_fire_plan; twins of packages/work/src/schedules/slots.ts). Daylight saving: a
--     local time that does not exist fires at the next valid minute, the moment the clocks
--     change; a repeated local time fires once, at its first occurrence. Catch-up after
--     downtime: skip fires the latest due slot only inside its 5-minute on-time window,
--     run_latest_once fires it once inside the 24-hour replay horizon, and every other due slot
--     is dropped, so an outage never ends in a burst;
--   * store_time_zones: the shop's zone per store, as the broker read Shopify's ianaTimezone in
--     the ShopIdentity document at the install, a re-authorisation (reconnect) and the daily
--     health read (morrow_vault.shopify_zone_record), and the Owner's override
--     (store_time_zone_set); the effective zone is the override, else Shopify's;
--   * schedules: Schedule@1 records of an agent installation, each with its own zone (the
--     body's timeZone), revised append-only into schedule_revisions with the actor of each
--     revision. A change of the shop's zone moves nothing: it raises or revises one open
--     schedule_zone_notices row per store (the Inbox item, "Your shop's time zone changed to
--     ... Move N schedules?", for the Owner and each listed schedule's owner), and each
--     schedule moves only on a person's tap (schedule_zone_move: the Owner or the schedule's
--     owner, who must be a recipient);
--   * mandate_triggers: MandateTrigger@1 rows (ADR-0024 item 6), ids and times only. This file
--     writes only kind schedule, keyed sched:<schedule id>:<slot UTC> and unique per tenant, so
--     a slot fires once whatever retries; admit_mandate_run (build order PR 21) is their only
--     reader-to-be, and a row lives 24 hours after its slot;
--   * the runtime executor's two definers, called per tenant from the orchestrator's cron under
--     its time budget: schedule_tenants_due (ids only, across tenants: one due schedule id per
--     tenant) and fire_due_schedules (ids only: the tenant comes from the schedule it names; at
--     most 25 due schedules a call, more reported).
-- Settings: morrow.schedule_sweep, morrow.schedule_target and morrow.schedule_fire (the runtime
-- executor) and morrow.schedule_zone (the vault broker) are written only by the definers below,
-- which overwrite all four on entry and clear them before returning; no other definer reads
-- these tables, and a later definer that does must overwrite them on entry too. Every policy
-- that reads one also names its login, and neither login holds a table privilege.
-- Left for later rows, by plan row SD12's own order: once schedules (after SD2's note on
-- ADR-0041 items 7 and 20), standing requests on Schedule@1 (after SD2's note on ADR-0040 item
-- 12), and the stop check at the writer (plan row SD14's effect_stops_clear; until then the
-- admission that reads a trigger row checks stops and drops a stopped one).
DO $$ BEGIN
 IF current_user<>'morrow_work_owner'
 OR NOT morrow_identity.morrow_memberships_closed()
 OR (SELECT count(*) FROM pg_catalog.pg_roles r WHERE r.rolname IN ('morrow_runtime_executor','morrow_vault_broker')
   AND morrow_identity.memberships_closed(r.rolname))<>2
 OR to_regclass('morrow_work.agent_installations') IS NULL
 OR to_regclass('morrow_work.schedules') IS NOT NULL OR to_regclass('morrow_work.store_time_zones') IS NOT NULL
 OR to_regclass('morrow_work.mandate_triggers') IS NOT NULL OR to_regclass('morrow_work.schedule_zone_notices') IS NOT NULL
 OR to_regprocedure('morrow_work.db_now()') IS NULL OR to_regprocedure('morrow_work.current_tenant()') IS NULL
 OR to_regprocedure('morrow_work.append_only()') IS NULL OR to_regprocedure('morrow_work.utc_text(timestamp with time zone)') IS NULL
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_executor_safe(text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_health_target(text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_store_installations(text,text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command',
   'morrow_identity.work_lock_and_recheck(text,text,text,text,text,text,text)','EXECUTE')
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_policies p WHERE p.schemaname='morrow_work' AND p.policyname LIKE 'schedule\_%')
 THEN RAISE EXCEPTION 'SCHEDULES_SHOP_ZONE_PREREQUISITES_INVALID'; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Pure functions: owned by the owner; the command role holds EXECUTE because CHECK constraints
-- and triggers run with the writer's privileges (the 0015 valid_scope pattern).
-- The closed zone list (tzdata 2026c; ADR-0043 item 8): PostgreSQL's and Intl's IANA zones under
-- the ten regions, with UTC and Etc/UTC. The twin of packages/contracts/src/time-zones.ts.
CREATE FUNCTION morrow_work.iana_time_zones() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp AS $$
 SELECT ARRAY[
 'Africa/Abidjan','Africa/Accra','Africa/Addis_Ababa','Africa/Algiers','Africa/Asmara','Africa/Bamako','Africa/Bangui','Africa/Banjul',
 'Africa/Bissau','Africa/Blantyre','Africa/Brazzaville','Africa/Bujumbura','Africa/Cairo','Africa/Casablanca','Africa/Ceuta','Africa/Conakry',
 'Africa/Dakar','Africa/Dar_es_Salaam','Africa/Djibouti','Africa/Douala','Africa/El_Aaiun','Africa/Freetown','Africa/Gaborone','Africa/Harare',
 'Africa/Johannesburg','Africa/Juba','Africa/Kampala','Africa/Khartoum','Africa/Kigali','Africa/Kinshasa','Africa/Lagos','Africa/Libreville',
 'Africa/Lome','Africa/Luanda','Africa/Lubumbashi','Africa/Lusaka','Africa/Malabo','Africa/Maputo','Africa/Maseru','Africa/Mbabane',
 'Africa/Mogadishu','Africa/Monrovia','Africa/Nairobi','Africa/Ndjamena','Africa/Niamey','Africa/Nouakchott','Africa/Ouagadougou','Africa/Porto-Novo',
 'Africa/Sao_Tome','Africa/Timbuktu','Africa/Tripoli','Africa/Tunis','Africa/Windhoek','America/Adak','America/Anchorage','America/Anguilla',
 'America/Antigua','America/Araguaina','America/Argentina/Buenos_Aires','America/Argentina/Catamarca','America/Argentina/Cordoba','America/Argentina/Jujuy','America/Argentina/La_Rioja','America/Argentina/Mendoza',
 'America/Argentina/Rio_Gallegos','America/Argentina/Salta','America/Argentina/San_Juan','America/Argentina/San_Luis','America/Argentina/Tucuman','America/Argentina/Ushuaia','America/Aruba','America/Asuncion',
 'America/Atikokan','America/Atka','America/Bahia','America/Bahia_Banderas','America/Barbados','America/Belem','America/Belize','America/Blanc-Sablon',
 'America/Boa_Vista','America/Bogota','America/Boise','America/Cambridge_Bay','America/Campo_Grande','America/Cancun','America/Caracas','America/Cayenne',
 'America/Cayman','America/Chicago','America/Chihuahua','America/Ciudad_Juarez','America/Coral_Harbour','America/Costa_Rica','America/Coyhaique','America/Creston',
 'America/Cuiaba','America/Curacao','America/Danmarkshavn','America/Dawson','America/Dawson_Creek','America/Denver','America/Detroit','America/Dominica',
 'America/Edmonton','America/Eirunepe','America/El_Salvador','America/Ensenada','America/Fort_Nelson','America/Fortaleza','America/Glace_Bay','America/Goose_Bay',
 'America/Grand_Turk','America/Grenada','America/Guadeloupe','America/Guatemala','America/Guayaquil','America/Guyana','America/Halifax','America/Havana',
 'America/Hermosillo','America/Indiana/Indianapolis','America/Indiana/Knox','America/Indiana/Marengo','America/Indiana/Petersburg','America/Indiana/Tell_City','America/Indiana/Vevay','America/Indiana/Vincennes',
 'America/Indiana/Winamac','America/Inuvik','America/Iqaluit','America/Jamaica','America/Juneau','America/Kentucky/Louisville','America/Kentucky/Monticello','America/Kralendijk',
 'America/La_Paz','America/Lima','America/Los_Angeles','America/Lower_Princes','America/Maceio','America/Managua','America/Manaus','America/Marigot',
 'America/Martinique','America/Matamoros','America/Mazatlan','America/Menominee','America/Merida','America/Metlakatla','America/Mexico_City','America/Miquelon',
 'America/Moncton','America/Monterrey','America/Montevideo','America/Montreal','America/Montserrat','America/Nassau','America/New_York','America/Nipigon',
 'America/Nome','America/Noronha','America/North_Dakota/Beulah','America/North_Dakota/Center','America/North_Dakota/New_Salem','America/Nuuk','America/Ojinaga','America/Panama',
 'America/Pangnirtung','America/Paramaribo','America/Phoenix','America/Port-au-Prince','America/Port_of_Spain','America/Porto_Acre','America/Porto_Velho','America/Puerto_Rico',
 'America/Punta_Arenas','America/Rainy_River','America/Rankin_Inlet','America/Recife','America/Regina','America/Resolute','America/Rio_Branco','America/Santa_Isabel',
 'America/Santarem','America/Santiago','America/Santo_Domingo','America/Sao_Paulo','America/Scoresbysund','America/Shiprock','America/Sitka','America/St_Barthelemy',
 'America/St_Johns','America/St_Kitts','America/St_Lucia','America/St_Thomas','America/St_Vincent','America/Swift_Current','America/Tegucigalpa','America/Thule',
 'America/Thunder_Bay','America/Tijuana','America/Toronto','America/Tortola','America/Vancouver','America/Virgin','America/Whitehorse','America/Winnipeg',
 'America/Yakutat','America/Yellowknife','Antarctica/Casey','Antarctica/Davis','Antarctica/DumontDUrville','Antarctica/Macquarie','Antarctica/Mawson','Antarctica/McMurdo',
 'Antarctica/Palmer','Antarctica/Rothera','Antarctica/Syowa','Antarctica/Troll','Antarctica/Vostok','Arctic/Longyearbyen','Asia/Aden','Asia/Almaty',
 'Asia/Amman','Asia/Anadyr','Asia/Aqtau','Asia/Aqtobe','Asia/Ashgabat','Asia/Atyrau','Asia/Baghdad','Asia/Bahrain',
 'Asia/Baku','Asia/Bangkok','Asia/Barnaul','Asia/Beirut','Asia/Bishkek','Asia/Brunei','Asia/Chita','Asia/Chongqing',
 'Asia/Colombo','Asia/Damascus','Asia/Dhaka','Asia/Dili','Asia/Dubai','Asia/Dushanbe','Asia/Famagusta','Asia/Gaza',
 'Asia/Harbin','Asia/Hebron','Asia/Ho_Chi_Minh','Asia/Hong_Kong','Asia/Hovd','Asia/Irkutsk','Asia/Istanbul','Asia/Jakarta',
 'Asia/Jayapura','Asia/Jerusalem','Asia/Kabul','Asia/Kamchatka','Asia/Karachi','Asia/Kashgar','Asia/Kathmandu','Asia/Khandyga',
 'Asia/Kolkata','Asia/Krasnoyarsk','Asia/Kuala_Lumpur','Asia/Kuching','Asia/Kuwait','Asia/Macau','Asia/Magadan','Asia/Makassar',
 'Asia/Manila','Asia/Muscat','Asia/Nicosia','Asia/Novokuznetsk','Asia/Novosibirsk','Asia/Omsk','Asia/Oral','Asia/Phnom_Penh',
 'Asia/Pontianak','Asia/Pyongyang','Asia/Qatar','Asia/Qostanay','Asia/Qyzylorda','Asia/Riyadh','Asia/Sakhalin','Asia/Samarkand',
 'Asia/Seoul','Asia/Shanghai','Asia/Singapore','Asia/Srednekolymsk','Asia/Taipei','Asia/Tashkent','Asia/Tbilisi','Asia/Tehran',
 'Asia/Tel_Aviv','Asia/Thimphu','Asia/Tokyo','Asia/Tomsk','Asia/Ulaanbaatar','Asia/Urumqi','Asia/Ust-Nera','Asia/Vientiane',
 'Asia/Vladivostok','Asia/Yakutsk','Asia/Yangon','Asia/Yekaterinburg','Asia/Yerevan','Atlantic/Azores','Atlantic/Bermuda','Atlantic/Canary',
 'Atlantic/Cape_Verde','Atlantic/Faroe','Atlantic/Jan_Mayen','Atlantic/Madeira','Atlantic/Reykjavik','Atlantic/South_Georgia','Atlantic/St_Helena','Atlantic/Stanley',
 'Australia/Adelaide','Australia/Brisbane','Australia/Broken_Hill','Australia/Canberra','Australia/Currie','Australia/Darwin','Australia/Eucla','Australia/Hobart',
 'Australia/Lindeman','Australia/Lord_Howe','Australia/Melbourne','Australia/Perth','Australia/Sydney','Australia/Yancowinna','Etc/UTC','Europe/Amsterdam',
 'Europe/Andorra','Europe/Astrakhan','Europe/Athens','Europe/Belfast','Europe/Belgrade','Europe/Berlin','Europe/Bratislava','Europe/Brussels',
 'Europe/Bucharest','Europe/Budapest','Europe/Busingen','Europe/Chisinau','Europe/Copenhagen','Europe/Dublin','Europe/Gibraltar','Europe/Guernsey',
 'Europe/Helsinki','Europe/Isle_of_Man','Europe/Istanbul','Europe/Jersey','Europe/Kaliningrad','Europe/Kirov','Europe/Kyiv','Europe/Lisbon',
 'Europe/Ljubljana','Europe/London','Europe/Luxembourg','Europe/Madrid','Europe/Malta','Europe/Mariehamn','Europe/Minsk','Europe/Monaco',
 'Europe/Moscow','Europe/Nicosia','Europe/Oslo','Europe/Paris','Europe/Podgorica','Europe/Prague','Europe/Riga','Europe/Rome',
 'Europe/Samara','Europe/San_Marino','Europe/Sarajevo','Europe/Saratov','Europe/Simferopol','Europe/Skopje','Europe/Sofia','Europe/Stockholm',
 'Europe/Tallinn','Europe/Tirane','Europe/Tiraspol','Europe/Ulyanovsk','Europe/Vaduz','Europe/Vatican','Europe/Vienna','Europe/Vilnius',
 'Europe/Volgograd','Europe/Warsaw','Europe/Zagreb','Europe/Zurich','Indian/Antananarivo','Indian/Chagos','Indian/Christmas','Indian/Cocos',
 'Indian/Comoro','Indian/Kerguelen','Indian/Mahe','Indian/Maldives','Indian/Mauritius','Indian/Mayotte','Indian/Reunion','Pacific/Apia',
 'Pacific/Auckland','Pacific/Bougainville','Pacific/Chatham','Pacific/Chuuk','Pacific/Easter','Pacific/Efate','Pacific/Fakaofo','Pacific/Fiji',
 'Pacific/Funafuti','Pacific/Galapagos','Pacific/Gambier','Pacific/Guadalcanal','Pacific/Guam','Pacific/Honolulu','Pacific/Johnston','Pacific/Kanton',
 'Pacific/Kiritimati','Pacific/Kosrae','Pacific/Kwajalein','Pacific/Majuro','Pacific/Marquesas','Pacific/Midway','Pacific/Nauru','Pacific/Niue',
 'Pacific/Norfolk','Pacific/Noumea','Pacific/Pago_Pago','Pacific/Palau','Pacific/Pitcairn','Pacific/Pohnpei','Pacific/Port_Moresby','Pacific/Rarotonga',
 'Pacific/Saipan','Pacific/Samoa','Pacific/Tahiti','Pacific/Tarawa','Pacific/Tongatapu','Pacific/Wake','Pacific/Wallis','Pacific/Yap',
 'UTC'
 ]::text[]
$$;
-- The zone of the list a name stands for: the name itself, or the zone of one of Intl's old
-- spellings that PostgreSQL does not list; NULL for anything else.
CREATE FUNCTION morrow_work.time_zone_canonical(p_name text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN p_name IS NULL THEN NULL WHEN p_name=ANY(morrow_work.iana_time_zones()) THEN p_name ELSE CASE p_name
  WHEN 'Africa/Asmera' THEN 'Africa/Asmara'
  WHEN 'America/Buenos_Aires' THEN 'America/Argentina/Buenos_Aires'
  WHEN 'America/Catamarca' THEN 'America/Argentina/Catamarca'
  WHEN 'America/Cordoba' THEN 'America/Argentina/Cordoba'
  WHEN 'America/Godthab' THEN 'America/Nuuk'
  WHEN 'America/Indianapolis' THEN 'America/Indiana/Indianapolis'
  WHEN 'America/Jujuy' THEN 'America/Argentina/Jujuy'
  WHEN 'America/Louisville' THEN 'America/Kentucky/Louisville'
  WHEN 'America/Mendoza' THEN 'America/Argentina/Mendoza'
  WHEN 'Asia/Calcutta' THEN 'Asia/Kolkata'
  WHEN 'Asia/Katmandu' THEN 'Asia/Kathmandu'
  WHEN 'Asia/Rangoon' THEN 'Asia/Yangon'
  WHEN 'Asia/Saigon' THEN 'Asia/Ho_Chi_Minh'
  WHEN 'Atlantic/Faeroe' THEN 'Atlantic/Faroe'
  WHEN 'Europe/Kiev' THEN 'Europe/Kyiv'
  WHEN 'Pacific/Enderbury' THEN 'Pacific/Kanton'
  WHEN 'Pacific/Ponape' THEN 'Pacific/Pohnpei'
  WHEN 'Pacific/Truk' THEN 'Pacific/Chuuk'
 END END
$$;
-- A local date YYYY-MM-DD that the calendar has (2020 to 2099), by arithmetic alone.
CREATE FUNCTION morrow_work.schedule_date_valid(p_text text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp AS $$
 SELECT COALESCE(p_text ~ '^(20[2-9][0-9])-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
  AND substr(p_text,9,2)::integer<=CASE substr(p_text,6,2)::integer WHEN 2 THEN
   CASE WHEN substr(p_text,1,4)::integer%4=0 AND (substr(p_text,1,4)::integer%100<>0 OR substr(p_text,1,4)::integer%400=0) THEN 29 ELSE 28 END
   WHEN 4 THEN 30 WHEN 6 THEN 30 WHEN 9 THEN 30 WHEN 11 THEN 30 ELSE 31 END,false)
$$;
-- HH:MM on a 5-minute mark, as minutes after local midnight; NULL when malformed.
CREATE FUNCTION morrow_work.schedule_time_minutes(p_text text) RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN p_text ~ '^([01][0-9]|2[0-3]):[0-5][05]$' THEN substr(p_text,1,2)::integer*60+substr(p_text,4,2)::integer END
$$;
-- Schedule@1 (ADR-0043 item 7), closed: exactly its kind's keys, schemaVersion 1, a zone of the
-- list, missedRun, real optional dates with the first no later than the last; daily: one to four
-- times ascending and at least 15 minutes apart, also across midnight; weekly: one to seven
-- days in week order and one time; monthly: day 1 to 28 or last and one time; every: one of the
-- eight steps. once is not a kind here (plan row SD12: after SD2's note).
CREATE FUNCTION morrow_work.schedule_body_valid(b jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp AS $$
DECLARE v_keys text[]; v_minutes integer[]; v_days integer[]; v_n integer; i integer;
BEGIN
 IF b IS NULL OR jsonb_typeof(b)<>'object' OR jsonb_typeof(b->'schemaVersion') IS DISTINCT FROM 'number'
  OR (b->>'schemaVersion')<>'1' OR jsonb_typeof(b->'kind') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
 v_keys:=CASE b->>'kind' WHEN 'daily' THEN ARRAY['times'] WHEN 'weekly' THEN ARRAY['daysOfWeek','time']
  WHEN 'monthly' THEN ARRAY['dayOfMonth','time'] WHEN 'every' THEN ARRAY['everyMinutes'] END;
 IF v_keys IS NULL OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(b) k)
   IS DISTINCT FROM (SELECT array_agg(k ORDER BY k) FROM unnest(v_keys||ARRAY['schemaVersion','kind','timeZone','missedRun','startDate',
    'endDate']) k) THEN RETURN false; END IF;
 IF jsonb_typeof(b->'timeZone') IS DISTINCT FROM 'string' OR NOT ((b->>'timeZone')=ANY(morrow_work.iana_time_zones()))
  OR jsonb_typeof(b->'missedRun') IS DISTINCT FROM 'string' OR (b->>'missedRun') NOT IN ('skip','run_latest_once') THEN RETURN false; END IF;
 IF NOT (b->'startDate'='null'::jsonb OR (jsonb_typeof(b->'startDate')='string' AND morrow_work.schedule_date_valid(b->>'startDate')))
  OR NOT (b->'endDate'='null'::jsonb OR (jsonb_typeof(b->'endDate')='string' AND morrow_work.schedule_date_valid(b->>'endDate')))
  OR (jsonb_typeof(b->'startDate')='string' AND jsonb_typeof(b->'endDate')='string' AND (b->>'startDate')>(b->>'endDate')) THEN
  RETURN false;
 END IF;
 CASE b->>'kind'
 WHEN 'daily' THEN
  IF jsonb_typeof(b->'times') IS DISTINCT FROM 'array' OR jsonb_array_length(b->'times') NOT BETWEEN 1 AND 4
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(b->'times') e WHERE jsonb_typeof(e)<>'string') THEN RETURN false; END IF;
  SELECT array_agg(morrow_work.schedule_time_minutes(e) ORDER BY n) INTO v_minutes FROM jsonb_array_elements_text(b->'times') WITH ORDINALITY x(e,n);
  IF array_position(v_minutes,NULL) IS NOT NULL THEN RETURN false; END IF;
  v_n:=cardinality(v_minutes);
  FOR i IN 2..v_n LOOP
   IF v_minutes[i]-v_minutes[i-1]<15 THEN RETURN false; END IF;
  END LOOP;
  IF v_n>1 AND v_minutes[1]+1440-v_minutes[v_n]<15 THEN RETURN false; END IF;
 WHEN 'weekly' THEN
  IF jsonb_typeof(b->'daysOfWeek') IS DISTINCT FROM 'array' OR jsonb_array_length(b->'daysOfWeek') NOT BETWEEN 1 AND 7
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(b->'daysOfWeek') e WHERE jsonb_typeof(e)<>'string')
   OR jsonb_typeof(b->'time') IS DISTINCT FROM 'string' OR morrow_work.schedule_time_minutes(b->>'time') IS NULL THEN RETURN false; END IF;
  SELECT array_agg(array_position(ARRAY['mon','tue','wed','thu','fri','sat','sun'],e) ORDER BY n) INTO v_days
   FROM jsonb_array_elements_text(b->'daysOfWeek') WITH ORDINALITY x(e,n);
  IF array_position(v_days,NULL) IS NOT NULL THEN RETURN false; END IF;
  FOR i IN 2..cardinality(v_days) LOOP
   IF v_days[i]<=v_days[i-1] THEN RETURN false; END IF;
  END LOOP;
 WHEN 'monthly' THEN
  IF NOT ((jsonb_typeof(b->'dayOfMonth')='number' AND (b->>'dayOfMonth') ~ '^([1-9]|1[0-9]|2[0-8])$') OR b->'dayOfMonth'='"last"'::jsonb)
   OR jsonb_typeof(b->'time') IS DISTINCT FROM 'string' OR morrow_work.schedule_time_minutes(b->>'time') IS NULL THEN RETURN false; END IF;
 WHEN 'every' THEN
  IF jsonb_typeof(b->'everyMinutes') IS DISTINCT FROM 'number' OR (b->>'everyMinutes') NOT IN ('15','30','60','120','180','240','360','720') THEN
   RETURN false;
  END IF;
 END CASE;
 RETURN true;
END $$;
-- The zone's offset from UTC at an instant, in whole minutes (local = UTC + offset).
CREATE FUNCTION morrow_work.schedule_offset_minutes(p_zone text,p_at timestamptz) RETURNS integer
LANGUAGE sql STABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp AS $$
 SELECT round(extract(epoch FROM (date_trunc('second',p_at) AT TIME ZONE p_zone)-(date_trunc('second',p_at) AT TIME ZONE 'UTC'))/60)::integer
$$;
-- The instant of a local wall-clock minute in a zone: the one instant that shows it; its first
-- occurrence when the clocks go back over it; and when the clocks go forward over it, the next
-- valid minute, the instant the clocks change (found by halving, minute by minute).
CREATE FUNCTION morrow_work.schedule_resolve_local(p_zone text,p_local timestamp) RETURNS timestamptz
LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp AS $$
DECLARE v_wall timestamptz:=p_local AT TIME ZONE 'UTC'; v_early timestamptz; v_late timestamptz; v_lo timestamptz; v_hi timestamptz;
 v_mid timestamptz; v_base integer; v_a boolean; v_b boolean;
BEGIN
 v_early:=v_wall-make_interval(mins=>morrow_work.schedule_offset_minutes(p_zone,v_wall-interval '1 day'));
 v_late:=v_wall-make_interval(mins=>morrow_work.schedule_offset_minutes(p_zone,v_wall+interval '1 day'));
 v_a:=(v_early AT TIME ZONE p_zone)=p_local;
 v_b:=(v_late AT TIME ZONE p_zone)=p_local;
 IF v_a AND v_b THEN RETURN least(v_early,v_late); END IF;
 IF v_a THEN RETURN v_early; END IF;
 IF v_b THEN RETURN v_late; END IF;
 v_lo:=least(v_early,v_late); v_hi:=greatest(v_early,v_late);
 v_base:=morrow_work.schedule_offset_minutes(p_zone,v_lo);
 WHILE v_hi-v_lo>interval '1 minute' LOOP
  v_mid:=v_lo+make_interval(mins=>floor(extract(epoch FROM v_hi-v_lo)/120)::integer);
  IF morrow_work.schedule_offset_minutes(p_zone,v_mid)=v_base THEN v_lo:=v_mid; ELSE v_hi:=v_mid; END IF;
 END LOOP;
 RETURN v_hi;
END $$;
-- The local minutes of one local date on which a valid body has slots, ascending.
CREATE FUNCTION morrow_work.schedule_day_slots(b jsonb,p_day date) RETURNS integer[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE b->>'kind'
  WHEN 'daily' THEN ARRAY(SELECT morrow_work.schedule_time_minutes(e) FROM jsonb_array_elements_text(b->'times') WITH ORDINALITY x(e,n) ORDER BY n)
  WHEN 'weekly' THEN CASE WHEN b->'daysOfWeek' ? (ARRAY['mon','tue','wed','thu','fri','sat','sun'])[extract(isodow FROM p_day)::integer]
   THEN ARRAY[morrow_work.schedule_time_minutes(b->>'time')] ELSE '{}'::integer[] END
  WHEN 'monthly' THEN CASE WHEN extract(day FROM p_day)::integer=CASE WHEN b->>'dayOfMonth'='last'
    THEN extract(day FROM (date_trunc('month',p_day::timestamp)+interval '1 month'-interval '1 day'))::integer
    ELSE (b->>'dayOfMonth')::integer END
   THEN ARRAY[morrow_work.schedule_time_minutes(b->>'time')] ELSE '{}'::integer[] END
  WHEN 'every' THEN ARRAY(SELECT g FROM generate_series(0,1439,(b->>'everyMinutes')::integer) g ORDER BY g)
 END
$$;
-- A valid body's first slot strictly after an instant, or NULL when none remains (its last
-- date passed). Starts a local day early, since a local time can resolve across the date.
CREATE FUNCTION morrow_work.schedule_next_slot(b jsonb,p_after timestamptz) RETURNS timestamptz
LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp AS $$
DECLARE v_zone text:=b->>'timeZone'; v_day date; v_first date; v_last date; v_minute integer; v_slot timestamptz; n integer:=0;
BEGIN
 v_first:=CASE WHEN jsonb_typeof(b->'startDate')='string' THEN to_date(b->>'startDate','YYYY-MM-DD') END;
 v_last:=CASE WHEN jsonb_typeof(b->'endDate')='string' THEN to_date(b->>'endDate','YYYY-MM-DD') END;
 v_day:=(p_after AT TIME ZONE v_zone)::date-1;
 IF v_first IS NOT NULL AND v_day<v_first THEN v_day:=v_first; END IF;
 WHILE n<400 LOOP
  IF v_last IS NOT NULL AND v_day>v_last THEN RETURN NULL; END IF;
  FOREACH v_minute IN ARRAY morrow_work.schedule_day_slots(b,v_day) LOOP
   v_slot:=morrow_work.schedule_resolve_local(v_zone,v_day::timestamp+make_interval(mins=>v_minute));
   IF v_slot>p_after THEN RETURN v_slot; END IF;
  END LOOP;
  v_day:=v_day+1; n:=n+1;
 END LOOP;
 RETURN NULL;
END $$;
-- One firing pass over a body whose next slot is p_next (always one of its slots) at p_now:
-- nothing is due before p_next; otherwise the latest due slot inside the window missedRun
-- allows (skip: 5 minutes; run_latest_once: the 24-hour replay horizon) fires once, every other
-- due slot is dropped (missed), and the next slot moves past p_now (NULL: the schedule ended).
CREATE FUNCTION morrow_work.schedule_fire_plan(b jsonb,p_next timestamptz,p_now timestamptz,OUT fire timestamptz,OUT next timestamptz,
 OUT missed boolean)
LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp AS $$
DECLARE v_zone text:=b->>'timeZone'; v_from timestamptz; v_day date; v_end date; v_first date; v_last date; v_minute integer;
 v_slot timestamptz;
BEGIN
 IF p_next>p_now THEN fire:=NULL; next:=p_next; missed:=false; RETURN; END IF;
 v_from:=greatest(p_next,p_now-CASE WHEN b->>'missedRun'='skip' THEN interval '5 minutes' ELSE interval '24 hours' END);
 v_first:=CASE WHEN jsonb_typeof(b->'startDate')='string' THEN to_date(b->>'startDate','YYYY-MM-DD') END;
 v_last:=CASE WHEN jsonb_typeof(b->'endDate')='string' THEN to_date(b->>'endDate','YYYY-MM-DD') END;
 v_day:=(v_from AT TIME ZONE v_zone)::date-1; v_end:=(p_now AT TIME ZONE v_zone)::date+1;
 fire:=NULL;
 WHILE v_day<=v_end LOOP
  IF (v_first IS NULL OR v_day>=v_first) AND (v_last IS NULL OR v_day<=v_last) THEN
   FOREACH v_minute IN ARRAY morrow_work.schedule_day_slots(b,v_day) LOOP
    v_slot:=morrow_work.schedule_resolve_local(v_zone,v_day::timestamp+make_interval(mins=>v_minute));
    IF v_slot>=v_from AND v_slot<=p_now AND (fire IS NULL OR v_slot>fire) THEN fire:=v_slot; END IF;
   END LOOP;
  END IF;
  v_day:=v_day+1;
 END LOOP;
 next:=morrow_work.schedule_next_slot(b,p_now);
 missed:=fire IS NULL OR fire<>p_next;
END $$;
-- A schedule slot's trigger key (ADR-0043 item 23): sched:<schedule id>:<slot UTC, seconds>.
CREATE FUNCTION morrow_work.schedule_trigger_key(p_schedule_id text,p_slot timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp AS $$
 SELECT 'sched:'||p_schedule_id||':'||to_char(p_slot AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
$$;
-- A list of at most p_max distinct ids (schedule ids, recipients).
CREATE FUNCTION morrow_work.schedule_ids_valid(p_list jsonb,p_max integer) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp AS $$
 SELECT p_list IS NOT NULL AND jsonb_typeof(p_list)='array' AND jsonb_array_length(p_list)<=p_max
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_list) e WHERE jsonb_typeof(e)<>'string'
   OR (e#>>'{}') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
  AND (SELECT count(DISTINCT e) FROM jsonb_array_elements_text(p_list) e)=jsonb_array_length(p_list)
$$;

-- ---------------------------------------------------------------------------
-- The shop's zone per store (ADR-0043 item 8). Shopify's zone, as the broker last read it,
-- and the Owner's override; the effective zone is the override, else Shopify's. Revised by one
-- each change; a daily read that finds the same zone marks only observed_at. No delete.
CREATE TABLE morrow_work.store_time_zones (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 store_id morrow_work.record_id NOT NULL,
 store_installation_id morrow_work.record_id NOT NULL,
 revision morrow_work.revision NOT NULL,
 shopify_zone text CHECK (shopify_zone=morrow_work.time_zone_canonical(shopify_zone)),
 shopify_source text CHECK (shopify_source IN ('install','reauthorise','health')),
 shopify_observed_at timestamptz CHECK (shopify_observed_at=date_trunc('milliseconds',shopify_observed_at) AND isfinite(shopify_observed_at)),
 override_zone text CHECK (override_zone=morrow_work.time_zone_canonical(override_zone)),
 override_principal_id morrow_work.record_id,
 override_at timestamptz CHECK (override_at=date_trunc('milliseconds',override_at) AND isfinite(override_at)),
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND created_at>=timestamptz '2000-01-01T00:00:00Z' AND created_at<timestamptz '9000-01-01T00:00:00Z'),
 updated_at timestamptz NOT NULL CHECK (updated_at=date_trunc('milliseconds',updated_at) AND isfinite(updated_at)),
 PRIMARY KEY (organization_id,workspace_id,store_id),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 CONSTRAINT store_time_zones_shopify CHECK ((shopify_zone IS NULL)=(shopify_source IS NULL) AND (shopify_zone IS NULL)=(shopify_observed_at IS NULL)),
 CONSTRAINT store_time_zones_override CHECK ((override_zone IS NULL)=(override_principal_id IS NULL) AND (override_zone IS NULL)=(override_at IS NULL)),
 CONSTRAINT store_time_zones_some CHECK (shopify_zone IS NOT NULL OR override_zone IS NOT NULL),
 CONSTRAINT store_time_zones_times CHECK (updated_at>=created_at)
);
CREATE FUNCTION morrow_work.store_time_zone_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['store_installation_id','revision','shopify_zone','shopify_source','shopify_observed_at','override_zone',
 'override_principal_id','override_at','updated_at'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.updated_at<>NEW.created_at THEN RAISE EXCEPTION 'WORK_STORE_ZONE_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.updated_at>=OLD.updated_at AND (to_jsonb(NEW)-v_mutable)=(to_jsonb(OLD)-v_mutable)
  AND (NEW.shopify_observed_at IS NULL OR OLD.shopify_observed_at IS NULL OR NEW.shopify_observed_at>=OLD.shopify_observed_at) THEN
  -- A change of either zone, or of who set the override, is one revision.
  IF NEW.revision=OLD.revision+1 THEN RETURN NEW; END IF;
  -- The same zone read again marks only when it was read.
  IF NEW.revision=OLD.revision AND (to_jsonb(NEW)-ARRAY['shopify_observed_at','shopify_source','updated_at'])
    =(to_jsonb(OLD)-ARRAY['shopify_observed_at','shopify_source','updated_at']) THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'WORK_STORE_ZONE_IMMUTABLE';
END $$;
CREATE TRIGGER store_time_zone_guard BEFORE INSERT OR UPDATE ON morrow_work.store_time_zones
 FOR EACH ROW EXECUTE FUNCTION morrow_work.store_time_zone_guard();
CREATE TRIGGER append_only BEFORE DELETE ON morrow_work.store_time_zones FOR EACH ROW EXECUTE FUNCTION morrow_work.append_only();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON morrow_work.store_time_zones FOR EACH STATEMENT EXECUTE FUNCTION morrow_work.append_only();

-- ---------------------------------------------------------------------------
-- Schedule@1 records (ADR-0043 item 7): one per (tenant, id), of one agent installation and its
-- store, owned by a person (who hears of a zone change). The body is the closed contract; its
-- zone is the schedule's own. next_slot_at is computed here, never written by a caller: at
-- creation and each revision from the body; by a firing pass only forward, and only to a slot
-- of the body. Ended once no slot remains. Revisions are append-only in schedule_revisions.
CREATE TABLE morrow_work.schedules (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 revision morrow_work.revision NOT NULL,
 store_id morrow_work.record_id NOT NULL,
 connection_id morrow_work.record_id NOT NULL,
 installation_id morrow_work.record_id NOT NULL,
 owner_principal_id morrow_work.record_id NOT NULL,
 purpose text NOT NULL CHECK (purpose IN ('mandate_routine','report','policy_trigger')),
 body jsonb NOT NULL CHECK (morrow_work.schedule_body_valid(body)),
 time_zone text NOT NULL,
 status text NOT NULL CHECK (status IN ('active','disabled','ended')),
 next_slot_at timestamptz CHECK (next_slot_at=date_trunc('minute',next_slot_at) AND isfinite(next_slot_at)),
 last_slot_at timestamptz CHECK (last_slot_at=date_trunc('minute',last_slot_at) AND isfinite(last_slot_at)),
 last_fired_at timestamptz CHECK (last_fired_at=date_trunc('milliseconds',last_fired_at) AND isfinite(last_fired_at)),
 revision_reason text NOT NULL CHECK (revision_reason IN ('created','zone_moved')),
 revised_by_kind text NOT NULL CHECK (revised_by_kind IN ('system','human')),
 revised_by_principal_id morrow_work.record_id,
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND created_at>=timestamptz '2000-01-01T00:00:00Z' AND created_at<timestamptz '9000-01-01T00:00:00Z'),
 updated_at timestamptz NOT NULL CHECK (updated_at=date_trunc('milliseconds',updated_at) AND isfinite(updated_at)),
 PRIMARY KEY (organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 FOREIGN KEY (organization_id,workspace_id,installation_id) REFERENCES morrow_work.agent_installations(organization_id,workspace_id,id),
 CONSTRAINT schedules_zone CHECK (time_zone=body->>'timeZone'),
 CONSTRAINT schedules_next CHECK ((status='active')=(next_slot_at IS NOT NULL)),
 CONSTRAINT schedules_actor CHECK ((revised_by_kind='human')=(revised_by_principal_id IS NOT NULL)),
 CONSTRAINT schedules_times CHECK (updated_at>=created_at AND (last_fired_at IS NULL OR last_fired_at>=created_at))
);
-- fire_due_schedules names a schedule by its id alone, so ids are unique across tenants.
CREATE UNIQUE INDEX schedules_id ON morrow_work.schedules (id);
CREATE INDEX schedules_due ON morrow_work.schedules (next_slot_at,organization_id,workspace_id,id) WHERE status='active';
CREATE INDEX schedules_store ON morrow_work.schedules (organization_id,workspace_id,store_id) WHERE status<>'ended';
CREATE FUNCTION morrow_work.schedule_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_fixed text[]:=ARRAY['organization_id','workspace_id','id','store_id','connection_id','installation_id','owner_principal_id',
 'purpose','created_at'];
 v_fire text[]:=ARRAY['next_slot_at','last_slot_at','last_fired_at','status','updated_at'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.status NOT IN ('active','disabled') OR NEW.revision_reason<>'created' OR NEW.updated_at<>NEW.created_at
   OR NEW.last_slot_at IS NOT NULL OR NEW.last_fired_at IS NOT NULL
   OR NOT EXISTS(SELECT 1 FROM morrow_work.agent_installations a WHERE a.organization_id=NEW.organization_id
    AND a.workspace_id=NEW.workspace_id AND a.id=NEW.installation_id AND a.store_id=NEW.store_id AND a.connection_id=NEW.connection_id) THEN
   RAISE EXCEPTION 'WORK_SCHEDULE_INVALID';
  END IF;
  NEW.next_slot_at:=CASE WHEN NEW.status='active' THEN morrow_work.schedule_next_slot(NEW.body,NEW.created_at) END;
  IF NEW.status='active' AND NEW.next_slot_at IS NULL THEN RAISE EXCEPTION 'WORK_SCHEDULE_NO_SLOT'; END IF;
  RETURN NEW;
 END IF;
 IF (SELECT bool_and(to_jsonb(NEW)->k=to_jsonb(OLD)->k) FROM unnest(v_fixed) k) AND NEW.updated_at>=OLD.updated_at THEN
  -- A firing pass: only the slot fields; the next slot forward, to a slot of the body, or none
  -- (ended); a fired slot no earlier than the slot that was next.
  IF NEW.revision=OLD.revision AND (to_jsonb(NEW)-v_fire)=(to_jsonb(OLD)-v_fire) AND OLD.status='active'
   AND ((NEW.status='active' AND NEW.next_slot_at>OLD.next_slot_at
     AND NEW.next_slot_at=morrow_work.schedule_next_slot(NEW.body,NEW.next_slot_at-interval '1 millisecond'))
    OR (NEW.status='ended' AND NEW.next_slot_at IS NULL))
   AND (NEW.last_slot_at IS NOT DISTINCT FROM OLD.last_slot_at OR (NEW.last_slot_at>=OLD.next_slot_at
    AND (NEW.next_slot_at IS NULL OR NEW.last_slot_at<NEW.next_slot_at)))
   AND (NEW.last_fired_at IS NOT DISTINCT FROM OLD.last_fired_at OR OLD.last_fired_at IS NULL OR NEW.last_fired_at>=OLD.last_fired_at) THEN
   RETURN NEW;
  END IF;
  -- A revision (a person's zone move): one more, of a schedule that has not ended; the slot is
  -- computed again from the new body.
  IF NEW.revision=OLD.revision+1 AND OLD.status<>'ended' AND NEW.status IN ('active','disabled')
   AND NEW.last_slot_at IS NOT DISTINCT FROM OLD.last_slot_at AND NEW.last_fired_at IS NOT DISTINCT FROM OLD.last_fired_at
   AND NEW.revision_reason<>'created' THEN
   NEW.next_slot_at:=CASE WHEN NEW.status='active' THEN morrow_work.schedule_next_slot(NEW.body,NEW.updated_at) END;
   IF NEW.status='active' AND NEW.next_slot_at IS NULL THEN NEW.status:='ended'; END IF;
   RETURN NEW;
  END IF;
 END IF;
 RAISE EXCEPTION 'WORK_SCHEDULE_IMMUTABLE';
END $$;
CREATE TRIGGER schedule_guard BEFORE INSERT OR UPDATE ON morrow_work.schedules FOR EACH ROW EXECUTE FUNCTION morrow_work.schedule_guard();
CREATE TRIGGER append_only BEFORE DELETE ON morrow_work.schedules FOR EACH ROW EXECUTE FUNCTION morrow_work.append_only();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON morrow_work.schedules FOR EACH STATEMENT EXECUTE FUNCTION morrow_work.append_only();

-- Every revision of a schedule, with its actor (the audit record of a person's move).
CREATE TABLE morrow_work.schedule_revisions (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 schedule_id morrow_work.record_id NOT NULL,
 revision morrow_work.revision NOT NULL,
 body jsonb NOT NULL CHECK (morrow_work.schedule_body_valid(body)),
 status text NOT NULL CHECK (status IN ('active','disabled','ended')),
 reason text NOT NULL CHECK (reason IN ('created','zone_moved')),
 actor_kind text NOT NULL CHECK (actor_kind IN ('system','human')),
 actor_principal_id morrow_work.record_id,
 recorded_at timestamptz NOT NULL CHECK (recorded_at=date_trunc('milliseconds',recorded_at) AND isfinite(recorded_at)),
 PRIMARY KEY (organization_id,workspace_id,schedule_id,revision),
 FOREIGN KEY (organization_id,workspace_id,schedule_id) REFERENCES morrow_work.schedules(organization_id,workspace_id,id),
 CONSTRAINT schedule_revisions_actor CHECK ((actor_kind='human')=(actor_principal_id IS NOT NULL))
);
CREATE FUNCTION morrow_work.schedule_revision_record() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' OR NEW.revision<>OLD.revision THEN
  INSERT INTO morrow_work.schedule_revisions(organization_id,workspace_id,schedule_id,revision,body,status,reason,actor_kind,
   actor_principal_id,recorded_at)
  VALUES (NEW.organization_id,NEW.workspace_id,NEW.id,NEW.revision,NEW.body,NEW.status,NEW.revision_reason,NEW.revised_by_kind,
   NEW.revised_by_principal_id,NEW.updated_at);
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER schedule_revision_record AFTER INSERT OR UPDATE ON morrow_work.schedules
 FOR EACH ROW EXECUTE FUNCTION morrow_work.schedule_revision_record();
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON morrow_work.schedule_revisions FOR EACH ROW EXECUTE FUNCTION morrow_work.append_only();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON morrow_work.schedule_revisions FOR EACH STATEMENT EXECUTE FUNCTION morrow_work.append_only();

-- ---------------------------------------------------------------------------
-- MandateTrigger@1 rows (ADR-0024 item 6; ADR-0043 items 5 and 9): server-held, ids and times
-- only, one per trigger key per tenant. This file writes only kind schedule (fire_due_schedules),
-- pending, due at its slot and expiring 24 hours later. admit_mandate_run (build order PR 21)
-- takes a row by id and is the only writer of its later states; no role may update one yet.
CREATE TABLE morrow_work.mandate_triggers (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 store_id morrow_work.record_id NOT NULL,
 installation_id morrow_work.record_id NOT NULL,
 kind text NOT NULL CHECK (kind='schedule'),
 trigger_key text NOT NULL CHECK (char_length(trigger_key)<=200 AND trigger_key ~ '^[a-z_]+:[A-Za-z0-9._:-]{1,190}$'),
 status text NOT NULL CHECK (status IN ('pending','admitted','expired')),
 due_at timestamptz NOT NULL CHECK (isfinite(due_at)),
 expires_at timestamptz NOT NULL CHECK (isfinite(expires_at)),
 schedule_id morrow_work.record_id NOT NULL,
 schedule_revision morrow_work.revision NOT NULL,
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND created_at>=timestamptz '2000-01-01T00:00:00Z' AND created_at<timestamptz '9000-01-01T00:00:00Z'),
 PRIMARY KEY (organization_id,workspace_id,id),
 UNIQUE (organization_id,workspace_id,trigger_key),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 FOREIGN KEY (organization_id,workspace_id,installation_id) REFERENCES morrow_work.agent_installations(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,schedule_id,schedule_revision)
  REFERENCES morrow_work.schedule_revisions(organization_id,workspace_id,schedule_id,revision),
 CONSTRAINT mandate_triggers_schedule_key CHECK (trigger_key=morrow_work.schedule_trigger_key(schedule_id,due_at)),
 CONSTRAINT mandate_triggers_life CHECK (expires_at=due_at+interval '24 hours' AND created_at>=due_at)
);
CREATE INDEX mandate_triggers_pending ON morrow_work.mandate_triggers (organization_id,workspace_id,installation_id,due_at)
 WHERE status='pending';
CREATE FUNCTION morrow_work.mandate_trigger_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'pending' THEN RAISE EXCEPTION 'WORK_TRIGGER_INVALID'; END IF;
  RETURN NEW;
 END IF;
 -- Admission's transitions (build order PR 21): pending to admitted or expired, nothing else.
 IF OLD.status='pending' AND NEW.status IN ('admitted','expired') AND (to_jsonb(NEW)-'status')=(to_jsonb(OLD)-'status') THEN
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'WORK_TRIGGER_IMMUTABLE';
END $$;
CREATE TRIGGER mandate_trigger_guard BEFORE INSERT OR UPDATE ON morrow_work.mandate_triggers
 FOR EACH ROW EXECUTE FUNCTION morrow_work.mandate_trigger_guard();
CREATE TRIGGER append_only BEFORE DELETE ON morrow_work.mandate_triggers FOR EACH ROW EXECUTE FUNCTION morrow_work.append_only();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON morrow_work.mandate_triggers FOR EACH STATEMENT EXECUTE FUNCTION morrow_work.append_only();

-- ---------------------------------------------------------------------------
-- The Inbox item of a shop zone change (ADR-0043 item 8): one open per store, for the Owner and
-- the owner of each listed schedule. It names the zone before and after and the store's
-- schedules whose zone is not the shop's new zone (up to 200 listed; schedule_count is all of
-- them). Revised when the zone changes again; cleared once nothing is left to move ('moved')
-- or a later change leaves nothing to move ('nothing_to_move'). Content-free: ids, zone names
-- from the closed list, counts and times. The Inbox screen and its item kind come with the
-- workspace's Inbox kinds; this table and schedule_zone_notices_open() are the seam.
CREATE TABLE morrow_work.schedule_zone_notices (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 revision morrow_work.revision NOT NULL,
 kind text NOT NULL CHECK (kind='zone_changed'),
 store_id morrow_work.record_id NOT NULL,
 store_installation_id morrow_work.record_id NOT NULL,
 from_zone text CHECK (from_zone=morrow_work.time_zone_canonical(from_zone)),
 to_zone text NOT NULL CHECK (to_zone=morrow_work.time_zone_canonical(to_zone)),
 schedule_ids jsonb NOT NULL CHECK (morrow_work.schedule_ids_valid(schedule_ids,200) AND jsonb_array_length(schedule_ids)>=1),
 schedule_count integer NOT NULL CHECK (schedule_count>=jsonb_array_length(schedule_ids)),
 recipients jsonb NOT NULL CHECK (morrow_work.schedule_ids_valid(recipients,50) AND jsonb_array_length(recipients)>=1),
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND created_at>=timestamptz '2000-01-01T00:00:00Z' AND created_at<timestamptz '9000-01-01T00:00:00Z'),
 updated_at timestamptz NOT NULL CHECK (updated_at=date_trunc('milliseconds',updated_at) AND isfinite(updated_at)),
 cleared_at timestamptz CHECK (cleared_at=date_trunc('milliseconds',cleared_at) AND isfinite(cleared_at)),
 cleared_reason text CHECK (cleared_reason IN ('moved','nothing_to_move')),
 PRIMARY KEY (organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 CONSTRAINT schedule_zone_notices_clear CHECK ((cleared_at IS NULL)=(cleared_reason IS NULL)),
 CONSTRAINT schedule_zone_notices_change CHECK (from_zone IS DISTINCT FROM to_zone),
 CONSTRAINT schedule_zone_notices_times CHECK (updated_at>=created_at AND (cleared_at IS NULL OR cleared_at>=created_at))
);
CREATE UNIQUE INDEX schedule_zone_notices_one_open ON morrow_work.schedule_zone_notices (organization_id,workspace_id,store_id)
 WHERE cleared_at IS NULL;
CREATE FUNCTION morrow_work.schedule_zone_notice_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['revision','from_zone','to_zone','schedule_ids','schedule_count','recipients','updated_at','cleared_at',
 'cleared_reason'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.cleared_at IS NOT NULL OR NEW.updated_at<>NEW.created_at THEN RAISE EXCEPTION 'WORK_ZONE_NOTICE_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.cleared_at IS NULL AND NEW.revision=OLD.revision+1 AND NEW.updated_at>=OLD.updated_at
  AND (to_jsonb(NEW)-v_mutable)=(to_jsonb(OLD)-v_mutable)
  AND (NEW.cleared_at IS NULL OR (NEW.cleared_at>=OLD.updated_at AND NEW.schedule_ids=OLD.schedule_ids AND NEW.to_zone=OLD.to_zone)) THEN
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'WORK_ZONE_NOTICE_IMMUTABLE';
END $$;
CREATE TRIGGER schedule_zone_notice_guard BEFORE INSERT OR UPDATE ON morrow_work.schedule_zone_notices
 FOR EACH ROW EXECUTE FUNCTION morrow_work.schedule_zone_notice_guard();
CREATE TRIGGER append_only BEFORE DELETE ON morrow_work.schedule_zone_notices FOR EACH ROW EXECUTE FUNCTION morrow_work.append_only();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON morrow_work.schedule_zone_notices FOR EACH STATEMENT EXECUTE FUNCTION morrow_work.append_only();

-- ---------------------------------------------------------------------------
-- Row security. Every table: ENABLE and FORCE, the owner's maintenance policy, and the session
-- template for the command role (current_tenant()): the api's reads and a person's override
-- and move, under the definers below. The runtime and vault contexts follow.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['store_time_zones','schedules','schedule_revisions','mandate_triggers','schedule_zone_notices'] LOOP
  EXECUTE format('ALTER TABLE morrow_work.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE morrow_work.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY work_owner ON morrow_work.%I TO morrow_work_owner USING (true) WITH CHECK (true)',t);
  EXECUTE format('REVOKE ALL ON morrow_work.%I FROM PUBLIC',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['store_time_zones','schedules','schedule_revisions','schedule_zone_notices'] LOOP
  EXECUTE format('CREATE POLICY tenant_command ON morrow_work.%I TO morrow_work_command
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))
   WITH CHECK ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))',t);
 END LOOP;
END $$;
-- Trigger rows are read in a session (a later Inbox or activity read); no session definer writes one.
CREATE POLICY tenant_command ON morrow_work.mandate_triggers FOR SELECT TO morrow_work_command
 USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c));
-- The runtime executor's firing context. morrow.schedule_sweep='due' lists due schedules across
-- tenants (ids only, schedule_tenants_due); morrow.schedule_target names one schedule id, to find
-- its tenant; morrow.schedule_fire names one org|ws, whose due schedules fire_due_schedules
-- advances and whose trigger rows it writes.
CREATE POLICY schedule_sweep ON morrow_work.schedules FOR SELECT TO morrow_work_command
 USING (session_user='morrow_runtime_executor' AND status='active' AND pg_catalog.current_setting('morrow.schedule_sweep',true)='due');
CREATE POLICY schedule_target ON morrow_work.schedules FOR SELECT TO morrow_work_command
 USING (session_user='morrow_runtime_executor' AND id::text=pg_catalog.current_setting('morrow.schedule_target',true));
CREATE POLICY schedule_fire_read ON morrow_work.schedules FOR SELECT TO morrow_work_command
 USING (session_user='morrow_runtime_executor'
  AND organization_id::text||'|'||workspace_id::text=pg_catalog.current_setting('morrow.schedule_fire',true));
CREATE POLICY schedule_fire_advance ON morrow_work.schedules FOR UPDATE TO morrow_work_command
 USING (session_user='morrow_runtime_executor'
  AND organization_id::text||'|'||workspace_id::text=pg_catalog.current_setting('morrow.schedule_fire',true))
 WITH CHECK (session_user='morrow_runtime_executor'
  AND organization_id::text||'|'||workspace_id::text=pg_catalog.current_setting('morrow.schedule_fire',true));
CREATE POLICY schedule_fire_triggers ON morrow_work.mandate_triggers FOR INSERT TO morrow_work_command
 WITH CHECK (session_user='morrow_runtime_executor' AND kind='schedule' AND status='pending'
  AND organization_id::text||'|'||workspace_id::text=pg_catalog.current_setting('morrow.schedule_fire',true));
-- The vault broker's zone context: morrow.schedule_zone names one org|ws|store, whose zone row,
-- open notice and schedules shopify_zone_record reads and writes (schedules read only).
CREATE POLICY schedule_zone_vault ON morrow_work.store_time_zones TO morrow_work_command
 USING (session_user='morrow_vault_broker'
  AND organization_id::text||'|'||workspace_id::text||'|'||store_id::text=pg_catalog.current_setting('morrow.schedule_zone',true))
 WITH CHECK (session_user='morrow_vault_broker'
  AND organization_id::text||'|'||workspace_id::text||'|'||store_id::text=pg_catalog.current_setting('morrow.schedule_zone',true));
CREATE POLICY schedule_zone_vault ON morrow_work.schedule_zone_notices TO morrow_work_command
 USING (session_user='morrow_vault_broker'
  AND organization_id::text||'|'||workspace_id::text||'|'||store_id::text=pg_catalog.current_setting('morrow.schedule_zone',true))
 WITH CHECK (session_user='morrow_vault_broker'
  AND organization_id::text||'|'||workspace_id::text||'|'||store_id::text=pg_catalog.current_setting('morrow.schedule_zone',true));
CREATE POLICY schedule_zone_vault_read ON morrow_work.schedules FOR SELECT TO morrow_work_command
 USING (session_user='morrow_vault_broker'
  AND organization_id::text||'|'||workspace_id::text||'|'||store_id::text=pg_catalog.current_setting('morrow.schedule_zone',true));
GRANT SELECT,INSERT ON morrow_work.store_time_zones,morrow_work.schedules,morrow_work.schedule_revisions,morrow_work.mandate_triggers,
 morrow_work.schedule_zone_notices TO morrow_work_command;
GRANT UPDATE (store_installation_id,revision,shopify_zone,shopify_source,shopify_observed_at,override_zone,override_principal_id,override_at,
 updated_at) ON morrow_work.store_time_zones TO morrow_work_command;
GRANT UPDATE (revision,body,time_zone,status,next_slot_at,last_slot_at,last_fired_at,revision_reason,revised_by_kind,revised_by_principal_id,
 updated_at) ON morrow_work.schedules TO morrow_work_command;
GRANT UPDATE (revision,from_zone,to_zone,schedule_ids,schedule_count,recipients,updated_at,cleared_at,cleared_reason)
 ON morrow_work.schedule_zone_notices TO morrow_work_command;

-- ---------------------------------------------------------------------------
-- The shared step after a store's effective zone changed (a revisable owner helper: INVOKER,
-- owned by the owner, EXECUTE for the command role; its callers are shopify_zone_record and
-- store_time_zone_set, each in its own context). It moves nothing: it lists the store's
-- schedules that have not ended and whose zone is not p_to, and raises or revises the store's
-- one open notice for the Owner (p_owner, when known) and each listed schedule's owner, or
-- clears it when nothing is left to move. Returns raised, revised, cleared or none.
CREATE FUNCTION morrow_work.store_zone_apply(p_org text,p_ws text,p_store_id text,p_store_installation_id text,p_from text,p_to text,
 p_owner text,p_at timestamptz) RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE n record; v_count integer; v_ids jsonb; v_recipients jsonb;
BEGIN
 SELECT * INTO n FROM morrow_work.schedule_zone_notices x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.store_id=p_store_id
  AND x.cleared_at IS NULL FOR UPDATE;
 SELECT count(*)::integer,COALESCE(jsonb_agg(to_jsonb(s.id::text) ORDER BY s.created_at,s.id) FILTER (WHERE s.rn<=200),'[]'::jsonb)
  INTO v_count,v_ids
  FROM (SELECT x.id,x.created_at,row_number() OVER (ORDER BY x.created_at,x.id) AS rn FROM morrow_work.schedules x
   WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.store_id=p_store_id AND x.status<>'ended' AND x.time_zone<>p_to) s;
 IF v_count=0 THEN
  IF n.id IS NOT NULL THEN
   UPDATE morrow_work.schedule_zone_notices x SET revision=x.revision+1,updated_at=greatest(p_at,x.updated_at),
    cleared_at=greatest(p_at,x.updated_at),cleared_reason='nothing_to_move'
    WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=n.id;
   RETURN 'cleared';
  END IF;
  RETURN 'none';
 END IF;
 -- The Owner first, then each listed schedule's owner, at most 50.
 SELECT COALESCE(jsonb_agg(to_jsonb(r.p) ORDER BY r.o,r.p),'[]'::jsonb) INTO v_recipients FROM (
   SELECT d.p,d.o FROM (SELECT DISTINCT ON (u.p) u.p,u.o FROM (
     SELECT p_owner AS p,0 AS o WHERE p_owner IS NOT NULL
     UNION ALL SELECT x.owner_principal_id::text,1 FROM morrow_work.schedules x
      WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id::text IN (SELECT jsonb_array_elements_text(v_ids))) u
    ORDER BY u.p,u.o) d
   ORDER BY d.o,d.p LIMIT 50) r;
 IF n.id IS NOT NULL THEN
  UPDATE morrow_work.schedule_zone_notices x SET revision=x.revision+1,from_zone=p_from,
   to_zone=p_to,schedule_ids=v_ids,schedule_count=v_count,recipients=v_recipients,updated_at=greatest(p_at,x.updated_at)
   WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=n.id;
  RETURN 'revised';
 END IF;
 INSERT INTO morrow_work.schedule_zone_notices(organization_id,workspace_id,id,revision,kind,store_id,store_installation_id,from_zone,to_zone,
  schedule_ids,schedule_count,recipients,created_at,updated_at)
 VALUES (p_org,p_ws,gen_random_uuid()::text,1,'zone_changed',p_store_id,p_store_installation_id,p_from,p_to,v_ids,v_count,v_recipients,p_at,p_at);
 RETURN 'raised';
END $$;

-- ---------------------------------------------------------------------------
-- The runtime executor's definers (EXECUTE for morrow_runtime_executor only; ids only; each
-- overwrites every schedule setting on entry and clears them before returning).
-- The cron's list (across tenants, ids only): one due schedule per tenant (its earliest), the
-- tenants whose earliest due slot is oldest first, at most 50.
CREATE FUNCTION morrow_work.schedule_tenants_due()
RETURNS TABLE(schedule_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
BEGIN
 PERFORM pg_catalog.set_config('morrow.schedule_sweep','',true),pg_catalog.set_config('morrow.schedule_target','',true),
  pg_catalog.set_config('morrow.schedule_fire','',true),pg_catalog.set_config('morrow.schedule_zone','',true);
 IF NOT morrow_identity.work_executor_safe('morrow_runtime_executor') THEN RETURN; END IF;
 PERFORM pg_catalog.set_config('morrow.schedule_sweep','due',true);
 RETURN QUERY SELECT d.id FROM (
   SELECT DISTINCT ON (x.organization_id,x.workspace_id) x.id::text AS id,x.next_slot_at AS at FROM morrow_work.schedules x
    WHERE x.status='active' AND x.next_slot_at<=morrow_work.db_now()
    ORDER BY x.organization_id,x.workspace_id,x.next_slot_at,x.id) d
  ORDER BY d.at,d.id LIMIT 50;
 PERFORM pg_catalog.set_config('morrow.schedule_sweep','',true);
END $$;
-- One firing pass over the due schedules of the tenant of the schedule p_schedule_id names
-- (ADR-0043 item 9): for each, at most 25 a call (more reports the rest), oldest slot first,
-- skipping a row another pass holds: the slot schedule_fire_plan picks is written as one
-- pending trigger row keyed sched:<schedule id>:<slot UTC> (a key already written is a
-- duplicate and writes nothing), every other due slot is dropped, and next_slot_at moves past
-- now (the schedule ends when no slot remains). Counts only. Outcomes: fired, not_found,
-- invalid, denied.
CREATE FUNCTION morrow_work.fire_due_schedules(p_schedule_id text)
RETURNS TABLE(outcome text,examined text,fired text,duplicate text,dropped text,ended text,more text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE t record; s record; p record; v_now timestamptz; n integer; v_examined integer:=0; v_fired integer:=0; v_duplicate integer:=0;
 v_dropped integer:=0; v_ended integer:=0; v_more boolean:=false;
BEGIN
 PERFORM pg_catalog.set_config('morrow.schedule_sweep','',true),pg_catalog.set_config('morrow.schedule_target','',true),
  pg_catalog.set_config('morrow.schedule_fire','',true),pg_catalog.set_config('morrow.schedule_zone','',true);
 IF NOT morrow_identity.work_executor_safe('morrow_runtime_executor') THEN
  RETURN QUERY SELECT 'denied'::text,'0','0','0','0','0','false'; RETURN;
 END IF;
 IF p_schedule_id IS NULL OR p_schedule_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN
  RETURN QUERY SELECT 'invalid'::text,'0','0','0','0','0','false'; RETURN;
 END IF;
 PERFORM pg_catalog.set_config('morrow.schedule_target',p_schedule_id,true);
 SELECT x.organization_id::text AS organization_id,x.workspace_id::text AS workspace_id INTO t FROM morrow_work.schedules x WHERE x.id=p_schedule_id;
 PERFORM pg_catalog.set_config('morrow.schedule_target','',true);
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,'0','0','0','0','0','false'; RETURN; END IF;
 PERFORM pg_catalog.set_config('morrow.schedule_fire',t.organization_id||'|'||t.workspace_id,true);
 v_now:=morrow_work.db_now();
 FOR s IN SELECT x.id::text AS id,x.revision,x.store_id::text AS store_id,x.installation_id::text AS installation_id,x.body,x.next_slot_at,
   x.last_slot_at
  FROM morrow_work.schedules x WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id AND x.status='active'
   AND x.next_slot_at<=v_now
  ORDER BY x.next_slot_at,x.id LIMIT 26 FOR UPDATE SKIP LOCKED LOOP
  IF v_examined=25 THEN v_more:=true; EXIT; END IF;
  v_examined:=v_examined+1;
  SELECT * INTO p FROM morrow_work.schedule_fire_plan(s.body,s.next_slot_at,v_now);
  IF p.fire IS NOT NULL THEN
   INSERT INTO morrow_work.mandate_triggers(organization_id,workspace_id,id,store_id,installation_id,kind,trigger_key,status,due_at,expires_at,
    schedule_id,schedule_revision,created_at)
   VALUES (t.organization_id,t.workspace_id,gen_random_uuid()::text,s.store_id,s.installation_id,'schedule',
    morrow_work.schedule_trigger_key(s.id,p.fire),'pending',p.fire,p.fire+interval '24 hours',s.id,s.revision,greatest(v_now,p.fire))
   ON CONFLICT (organization_id,workspace_id,trigger_key) DO NOTHING;
   GET DIAGNOSTICS n=ROW_COUNT;
   IF n=1 THEN v_fired:=v_fired+1; ELSE v_duplicate:=v_duplicate+1; END IF;
  END IF;
  IF p.missed THEN v_dropped:=v_dropped+1; END IF;
  IF p.next IS NULL THEN v_ended:=v_ended+1; END IF;
  UPDATE morrow_work.schedules x SET next_slot_at=p.next,status=CASE WHEN p.next IS NULL THEN 'ended' ELSE 'active' END,
   last_slot_at=COALESCE(p.fire,x.last_slot_at),last_fired_at=CASE WHEN p.fire IS NULL THEN x.last_fired_at ELSE v_now END,
   updated_at=greatest(v_now,x.updated_at)
   WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id AND x.id=s.id;
 END LOOP;
 PERFORM pg_catalog.set_config('morrow.schedule_fire','',true);
 RETURN QUERY SELECT 'fired'::text,v_examined::text,v_fired::text,v_duplicate::text,v_dropped::text,v_ended::text,v_more::text;
END $$;

-- ---------------------------------------------------------------------------
-- The vault broker's record of the shop's zone (EXECUTE for morrow_vault_broker only): Shopify's
-- ianaTimezone, as the broker read it in the ShopIdentity document with the installation's own
-- token at the install or a re-authorisation, or in the daily health read. The tenant and the
-- store come from the installation itself (work_shopify_health_target), unlinked or linked and
-- not redacted. A name off the list (or one of Intl's old spellings, mapped) records nothing.
-- A changed effective zone moves no schedule: store_zone_apply raises the Inbox item.
-- Outcomes: recorded, unchanged, unrecognised, ineligible, not_found, invalid, denied.
CREATE FUNCTION morrow_vault.shopify_zone_record(p_installation_id text,p_zone text,p_source text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
DECLARE h record; r record; v_zone text; v_now timestamptz; v_before text; v_after text;
BEGIN
 PERFORM pg_catalog.set_config('morrow.schedule_sweep','',true),pg_catalog.set_config('morrow.schedule_target','',true),
  pg_catalog.set_config('morrow.schedule_fire','',true),pg_catalog.set_config('morrow.schedule_zone','',true);
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN RETURN 'denied'; END IF;
 IF p_installation_id IS NULL OR p_installation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_zone IS NULL OR char_length(p_zone)>64
  OR p_source IS NULL OR p_source NOT IN ('install','reauthorise','health') THEN RETURN 'invalid'; END IF;
 v_zone:=morrow_work.time_zone_canonical(p_zone);
 IF v_zone IS NULL THEN RETURN 'unrecognised'; END IF;
 SELECT * INTO h FROM morrow_identity.work_shopify_health_target(p_installation_id);
 IF h.outcome IS DISTINCT FROM 'found' THEN RETURN COALESCE(h.outcome,'not_found'); END IF;
 IF h.status NOT IN ('unlinked','linked') OR h.redacted THEN RETURN 'ineligible'; END IF;
 PERFORM pg_catalog.set_config('morrow.schedule_zone',h.organization_id||'|'||h.workspace_id||'|'||h.store_id,true);
 v_now:=morrow_work.db_now();
 SELECT * INTO r FROM morrow_work.store_time_zones x WHERE x.organization_id=h.organization_id AND x.workspace_id=h.workspace_id
  AND x.store_id=h.store_id FOR UPDATE;
 IF NOT FOUND THEN
  INSERT INTO morrow_work.store_time_zones(organization_id,workspace_id,store_id,store_installation_id,revision,shopify_zone,shopify_source,
   shopify_observed_at,created_at,updated_at)
  VALUES (h.organization_id,h.workspace_id,h.store_id,p_installation_id,1,v_zone,p_source,v_now,v_now,v_now);
  v_before:=NULL; v_after:=v_zone;
 ELSIF r.shopify_zone IS NOT DISTINCT FROM v_zone AND r.store_installation_id=p_installation_id THEN
  UPDATE morrow_work.store_time_zones x SET shopify_observed_at=greatest(v_now,x.shopify_observed_at),shopify_source=p_source,
   updated_at=greatest(v_now,x.updated_at)
   WHERE x.organization_id=h.organization_id AND x.workspace_id=h.workspace_id AND x.store_id=h.store_id;
  PERFORM pg_catalog.set_config('morrow.schedule_zone','',true);
  RETURN 'unchanged';
 ELSE
  UPDATE morrow_work.store_time_zones x SET revision=x.revision+1,store_installation_id=p_installation_id,shopify_zone=v_zone,
   shopify_source=p_source,shopify_observed_at=greatest(v_now,COALESCE(x.shopify_observed_at,v_now)),updated_at=greatest(v_now,x.updated_at)
   WHERE x.organization_id=h.organization_id AND x.workspace_id=h.workspace_id AND x.store_id=h.store_id;
  v_before:=COALESCE(r.override_zone,r.shopify_zone); v_after:=COALESCE(r.override_zone,v_zone);
 END IF;
 IF v_after IS DISTINCT FROM v_before THEN
  PERFORM morrow_work.store_zone_apply(h.organization_id,h.workspace_id,h.store_id,p_installation_id,v_before,v_after,h.owner_principal_id,v_now);
 END IF;
 PERFORM pg_catalog.set_config('morrow.schedule_zone','',true);
 RETURN 'recorded';
END $$;

-- ---------------------------------------------------------------------------
-- The api's definers (EXECUTE for morrow_work_api only; the session's tenant and person only,
-- through current_tenant(); a person's write rechecks the session's authority under the
-- organization's lock, work_lock_and_recheck, as the command prelude does).
-- A store's zone as the session's tenant sees it: Shopify's, the override and the effective
-- zone, with the row's revision (0 before any). Any member of the workspace may read it.
CREATE FUNCTION morrow_work.store_time_zone(p_store_id text)
RETURNS TABLE(store_id text,shopify_zone text,override_zone text,effective_zone text,revision text,observed_at text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE t record;
BEGIN
 IF p_store_id IS NULL OR p_store_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN RETURN; END IF;
 SELECT c.organization_id,c.workspace_id INTO t FROM morrow_work.current_tenant() c;
 IF NOT FOUND THEN RETURN; END IF;
 RETURN QUERY SELECT x.store_id::text,x.shopify_zone,x.override_zone,COALESCE(x.override_zone,x.shopify_zone),x.revision::text,
  CASE WHEN x.shopify_observed_at IS NULL THEN NULL ELSE morrow_work.utc_text(x.shopify_observed_at) END
  FROM morrow_work.store_time_zones x WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id AND x.store_id=p_store_id;
END $$;
-- The Owner's override of a store's zone (ADR-0043 item 8): a zone of the list, or the empty
-- string to follow Shopify's again, at the revision the Owner's screen read (0 before any row).
-- Only the Owner (the organization's founding principal) may set it. A changed effective zone
-- moves no schedule: the Inbox item asks. Outcomes: set, unchanged, stale, forbidden,
-- not_found, invalid, ineligible, stale_authority.
CREATE FUNCTION morrow_work.store_time_zone_set(p_store_id text,p_zone text,p_expected_revision text)
RETURNS TABLE(outcome text,revision text,effective_zone text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE t record; i record; h record; r record; v_check text; v_now timestamptz; v_zone text; v_before text; v_after text;
BEGIN
 IF p_store_id IS NULL OR p_store_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_zone IS NULL
  OR (p_zone<>'' AND NOT (p_zone=ANY(morrow_work.iana_time_zones())))
  OR p_expected_revision IS NULL OR p_expected_revision !~ '^(0|[1-9][0-9]{0,15})$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN;
 END IF;
 v_zone:=NULLIF(p_zone,'');
 SELECT c.organization_id,c.workspace_id,c.principal_id INTO t FROM morrow_work.current_tenant() c;
 IF NOT FOUND THEN RETURN QUERY SELECT 'ineligible'::text,NULL::text,NULL::text; RETURN; END IF;
 v_check:=morrow_identity.work_lock_and_recheck(
  pg_catalog.current_setting('morrow.work_session_digest',true),pg_catalog.current_setting('morrow.work_workspace',true),
  pg_catalog.current_setting('morrow.work_principal_id',true),pg_catalog.current_setting('morrow.work_membership_id',true),
  pg_catalog.current_setting('morrow.work_policy_revision',true),pg_catalog.current_setting('morrow.work_grants_digest',true),
  pg_catalog.current_setting('morrow.work_evaluated_at_us',true));
 IF v_check='ineligible' THEN RETURN QUERY SELECT 'ineligible'::text,NULL::text,NULL::text; RETURN; END IF;
 IF v_check IS DISTINCT FROM 'current' THEN RETURN QUERY SELECT 'stale_authority'::text,NULL::text,NULL::text; RETURN; END IF;
 SELECT x.installation_id INTO i FROM morrow_identity.work_store_installations(t.organization_id,t.workspace_id) x
  WHERE x.store_id=p_store_id AND x.status IN ('unlinked','linked') ORDER BY x.linked_at DESC NULLS LAST LIMIT 1;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text; RETURN; END IF;
 SELECT * INTO h FROM morrow_identity.work_shopify_health_target(i.installation_id);
 IF h.outcome IS DISTINCT FROM 'found' THEN RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text; RETURN; END IF;
 IF h.owner_principal_id IS DISTINCT FROM t.principal_id THEN RETURN QUERY SELECT 'forbidden'::text,NULL::text,NULL::text; RETURN; END IF;
 v_now:=morrow_work.db_now();
 SELECT * INTO r FROM morrow_work.store_time_zones x WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id
  AND x.store_id=p_store_id FOR UPDATE;
 IF COALESCE(r.revision,0)::text<>p_expected_revision THEN
  RETURN QUERY SELECT 'stale'::text,COALESCE(r.revision,0)::text,COALESCE(r.override_zone,r.shopify_zone); RETURN;
 END IF;
 IF r.store_id IS NULL THEN
  IF v_zone IS NULL THEN RETURN QUERY SELECT 'unchanged'::text,'0'::text,NULL::text; RETURN; END IF;
  INSERT INTO morrow_work.store_time_zones(organization_id,workspace_id,store_id,store_installation_id,revision,override_zone,
   override_principal_id,override_at,created_at,updated_at)
  VALUES (t.organization_id,t.workspace_id,p_store_id,i.installation_id,1,v_zone,t.principal_id,v_now,v_now,v_now);
  v_before:=NULL;
 ELSIF r.override_zone IS NOT DISTINCT FROM v_zone THEN
  RETURN QUERY SELECT 'unchanged'::text,r.revision::text,COALESCE(r.override_zone,r.shopify_zone); RETURN;
 ELSIF v_zone IS NULL AND r.shopify_zone IS NULL THEN
  -- Nothing would remain to follow: an override is cleared only once Shopify's zone is known.
  RETURN QUERY SELECT 'invalid'::text,r.revision::text,r.override_zone; RETURN;
 ELSE
  UPDATE morrow_work.store_time_zones x SET revision=x.revision+1,override_zone=v_zone,
   override_principal_id=CASE WHEN v_zone IS NULL THEN NULL ELSE t.principal_id END,
   override_at=CASE WHEN v_zone IS NULL THEN NULL ELSE greatest(v_now,x.updated_at) END,updated_at=greatest(v_now,x.updated_at)
   WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id AND x.store_id=p_store_id;
  v_before:=COALESCE(r.override_zone,r.shopify_zone);
 END IF;
 SELECT x.revision,COALESCE(x.override_zone,x.shopify_zone) AS zone INTO r FROM morrow_work.store_time_zones x
  WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id AND x.store_id=p_store_id;
 v_after:=r.zone;
 IF v_after IS DISTINCT FROM v_before THEN
  PERFORM morrow_work.store_zone_apply(t.organization_id,t.workspace_id,p_store_id,i.installation_id,v_before,v_after,h.owner_principal_id,v_now);
 END IF;
 RETURN QUERY SELECT 'set'::text,r.revision::text,v_after;
END $$;
-- The viewer's open zone-change items (session only, recipients only): ids, zone names, counts
-- and times; pending is how many of the store's schedules still are not in the new zone. At
-- most 20, newest first.
CREATE FUNCTION morrow_work.schedule_zone_notices_open()
RETURNS TABLE(notice_id text,store_id text,from_zone text,to_zone text,schedule_count text,pending text,schedule_ids text,revision text,
 created_at text,updated_at text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE t record;
BEGIN
 SELECT c.organization_id,c.workspace_id,c.principal_id INTO t FROM morrow_work.current_tenant() c;
 IF NOT FOUND THEN RETURN; END IF;
 RETURN QUERY SELECT n.id::text,n.store_id::text,n.from_zone,n.to_zone,n.schedule_count::text,
  (SELECT count(*) FROM morrow_work.schedules x WHERE x.organization_id=n.organization_id AND x.workspace_id=n.workspace_id
    AND x.store_id=n.store_id AND x.status<>'ended' AND x.time_zone<>n.to_zone)::text,
  n.schedule_ids::text,n.revision::text,morrow_work.utc_text(n.created_at),morrow_work.utc_text(n.updated_at)
  FROM morrow_work.schedule_zone_notices n
  WHERE n.organization_id=t.organization_id AND n.workspace_id=t.workspace_id AND n.cleared_at IS NULL AND n.recipients ? t.principal_id
  ORDER BY n.updated_at DESC,n.id LIMIT 20;
END $$;
-- A person's tap on the zone-change item (ADR-0043 item 8): moves one schedule of the item's
-- store, at the revision the person saw, into the item's new zone. The person must be one of
-- the item's recipients and either the Owner or the schedule's owner. The schedule's slot is
-- computed again in its new zone (schedule_guard), the revision records the person, and the
-- item clears once nothing is left to move. Outcomes: moved, unchanged, stale, forbidden,
-- not_found, invalid, ineligible, stale_authority.
CREATE FUNCTION morrow_work.schedule_zone_move(p_notice_id text,p_schedule_id text,p_expected_revision text)
RETURNS TABLE(outcome text,revision text,next_slot_at text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE t record; n record; s record; h record; v_check text; v_now timestamptz; v_left integer;
BEGIN
 IF p_notice_id IS NULL OR p_notice_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_schedule_id IS NULL OR p_schedule_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_expected_revision IS NULL OR p_expected_revision !~ '^[1-9][0-9]{0,15}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT c.organization_id,c.workspace_id,c.principal_id INTO t FROM morrow_work.current_tenant() c;
 IF NOT FOUND THEN RETURN QUERY SELECT 'ineligible'::text,NULL::text,NULL::text; RETURN; END IF;
 v_check:=morrow_identity.work_lock_and_recheck(
  pg_catalog.current_setting('morrow.work_session_digest',true),pg_catalog.current_setting('morrow.work_workspace',true),
  pg_catalog.current_setting('morrow.work_principal_id',true),pg_catalog.current_setting('morrow.work_membership_id',true),
  pg_catalog.current_setting('morrow.work_policy_revision',true),pg_catalog.current_setting('morrow.work_grants_digest',true),
  pg_catalog.current_setting('morrow.work_evaluated_at_us',true));
 IF v_check='ineligible' THEN RETURN QUERY SELECT 'ineligible'::text,NULL::text,NULL::text; RETURN; END IF;
 IF v_check IS DISTINCT FROM 'current' THEN RETURN QUERY SELECT 'stale_authority'::text,NULL::text,NULL::text; RETURN; END IF;
 SELECT * INTO n FROM morrow_work.schedule_zone_notices x WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id
  AND x.id=p_notice_id AND x.cleared_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text; RETURN; END IF;
 IF NOT (n.recipients ? t.principal_id) THEN RETURN QUERY SELECT 'forbidden'::text,NULL::text,NULL::text; RETURN; END IF;
 SELECT * INTO s FROM morrow_work.schedules x WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id
  AND x.id=p_schedule_id AND x.store_id=n.store_id FOR UPDATE;
 IF NOT FOUND OR s.status='ended' THEN RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text; RETURN; END IF;
 SELECT * INTO h FROM morrow_identity.work_shopify_health_target(n.store_installation_id);
 IF s.owner_principal_id::text<>t.principal_id AND h.owner_principal_id IS DISTINCT FROM t.principal_id THEN
  RETURN QUERY SELECT 'forbidden'::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF s.revision::text<>p_expected_revision THEN
  RETURN QUERY SELECT 'stale'::text,s.revision::text,CASE WHEN s.next_slot_at IS NULL THEN NULL ELSE morrow_work.utc_text(s.next_slot_at) END;
  RETURN;
 END IF;
 IF s.time_zone=n.to_zone THEN
  RETURN QUERY SELECT 'unchanged'::text,s.revision::text,CASE WHEN s.next_slot_at IS NULL THEN NULL ELSE morrow_work.utc_text(s.next_slot_at) END;
  RETURN;
 END IF;
 v_now:=morrow_work.db_now();
 UPDATE morrow_work.schedules x SET revision=x.revision+1,body=jsonb_set(x.body,'{timeZone}',to_jsonb(n.to_zone)),time_zone=n.to_zone,
  revision_reason='zone_moved',revised_by_kind='human',revised_by_principal_id=t.principal_id,updated_at=greatest(v_now,x.updated_at)
  WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id AND x.id=p_schedule_id;
 SELECT count(*)::integer INTO v_left FROM morrow_work.schedules x WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id
  AND x.store_id=n.store_id AND x.status<>'ended' AND x.time_zone<>n.to_zone;
 IF v_left=0 THEN
  UPDATE morrow_work.schedule_zone_notices x SET revision=x.revision+1,updated_at=greatest(v_now,x.updated_at),
   cleared_at=greatest(v_now,x.updated_at),cleared_reason='moved'
   WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id AND x.id=n.id;
 END IF;
 RETURN QUERY SELECT 'moved'::text,x.revision::text,CASE WHEN x.next_slot_at IS NULL THEN NULL ELSE morrow_work.utc_text(x.next_slot_at) END
  FROM morrow_work.schedules x WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id AND x.id=p_schedule_id;
END $$;

-- ---------------------------------------------------------------------------
-- Explicit ACLs per function (S5 and S7 read proacl), then the ownership transfer.
REVOKE ALL ON FUNCTION morrow_work.iana_time_zones(),morrow_work.time_zone_canonical(text),morrow_work.schedule_date_valid(text),
 morrow_work.schedule_time_minutes(text),morrow_work.schedule_body_valid(jsonb),morrow_work.schedule_offset_minutes(text,timestamptz),
 morrow_work.schedule_resolve_local(text,timestamp),morrow_work.schedule_day_slots(jsonb,date),
 morrow_work.schedule_next_slot(jsonb,timestamptz),morrow_work.schedule_fire_plan(jsonb,timestamptz,timestamptz),
 morrow_work.schedule_trigger_key(text,timestamptz),morrow_work.schedule_ids_valid(jsonb,integer),morrow_work.store_time_zone_guard(),
 morrow_work.schedule_guard(),morrow_work.schedule_revision_record(),morrow_work.mandate_trigger_guard(),
 morrow_work.schedule_zone_notice_guard(),
 morrow_work.store_zone_apply(text,text,text,text,text,text,text,timestamptz),morrow_work.schedule_tenants_due(),
 morrow_work.fire_due_schedules(text),morrow_vault.shopify_zone_record(text,text,text),morrow_work.store_time_zone(text),
 morrow_work.store_time_zone_set(text,text,text),morrow_work.schedule_zone_notices_open(),morrow_work.schedule_zone_move(text,text,text)
 FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_work.iana_time_zones(),morrow_work.time_zone_canonical(text),morrow_work.schedule_date_valid(text),
 morrow_work.schedule_time_minutes(text),morrow_work.schedule_body_valid(jsonb),morrow_work.schedule_offset_minutes(text,timestamptz),
 morrow_work.schedule_resolve_local(text,timestamp),morrow_work.schedule_day_slots(jsonb,date),
 morrow_work.schedule_next_slot(jsonb,timestamptz),morrow_work.schedule_fire_plan(jsonb,timestamptz,timestamptz),
 morrow_work.schedule_trigger_key(text,timestamptz),morrow_work.schedule_ids_valid(jsonb,integer),
 morrow_work.store_zone_apply(text,text,text,text,text,text,text,timestamptz) TO morrow_work_command;
GRANT EXECUTE ON FUNCTION morrow_work.schedule_tenants_due(),morrow_work.fire_due_schedules(text) TO morrow_runtime_executor;
GRANT EXECUTE ON FUNCTION morrow_vault.shopify_zone_record(text,text,text) TO morrow_vault_broker;
GRANT EXECUTE ON FUNCTION morrow_work.store_time_zone(text),morrow_work.store_time_zone_set(text,text,text),
 morrow_work.schedule_zone_notices_open(),morrow_work.schedule_zone_move(text,text,text) TO morrow_work_api;
GRANT CREATE ON SCHEMA morrow_work,morrow_vault TO morrow_work_command;
ALTER FUNCTION morrow_work.schedule_tenants_due() OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.fire_due_schedules(text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_vault.shopify_zone_record(text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.store_time_zone(text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.store_time_zone_set(text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.schedule_zone_notices_open() OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.schedule_zone_move(text,text,text) OWNER TO morrow_work_command;
REVOKE CREATE ON SCHEMA morrow_work,morrow_vault FROM morrow_work_command;
COMMIT;
