-- Run in Supabase after the Grant Factory migration. No public storage policies.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('grant-factory','grant-factory',false,3145728,array['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/plain'])
on conflict(id) do update set public=false,file_size_limit=3145728,allowed_mime_types=excluded.allowed_mime_types;
-- Files are uploaded and downloaded through the membership-checked server endpoint.
-- Do not add authenticated or anonymous object policies for this bucket.
