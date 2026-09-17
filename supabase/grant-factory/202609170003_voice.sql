create or replace function public.gf_set_voice(p_org uuid,p_actor uuid,p_expected integer,p_voice text) returns integer
language plpgsql security definer set search_path=public,pg_temp as $$
declare ver integer; old_voice text; begin
 if not exists(select 1 from gf_members where org_id=p_org and user_id=p_actor and role='OWNER') then raise exception 'Owner approval required'; end if;
 select brain_revision,voice into ver,old_voice from gf_workspaces where org_id=p_org for update;
 if ver is distinct from p_expected then raise exception 'Revision conflict'; end if;
 if length(p_voice)<10 or length(p_voice)>3000 then raise exception 'Voice must be 10 to 3000 characters'; end if;
 update gf_workspaces set voice=p_voice,brain_revision=brain_revision+1 where org_id=p_org returning brain_revision into ver;
 insert into gf_history(org_id,entity_id,entity_type,actor_id,event_type,revision,content) values(p_org,p_org,'workspace',p_actor,'VOICE_EDIT',ver,jsonb_build_object('before',old_voice,'after',p_voice));
 return ver;
end $$;
revoke all on function public.gf_set_voice(uuid,uuid,integer,text) from public,anon,authenticated;
grant execute on function public.gf_set_voice(uuid,uuid,integer,text) to service_role;
