--
-- PostgreSQL database dump
--

-- Dumped from database version 12.2
-- Dumped by pg_dump version 12.2

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: ltree; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS ltree WITH SCHEMA public;


--
-- Name: EXTENSION ltree; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION ltree IS 'data type for hierarchical tree-like structures';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: actions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.actions (
    identifier character varying(250) NOT NULL,
    name jsonb NOT NULL,
    code character varying(65535) NOT NULL,
    triggers jsonb NOT NULL,
    id integer NOT NULL,
    "tenantId" character varying(50) NOT NULL,
    "createdBy" character varying(250) NOT NULL,
    "updatedBy" character varying(250) NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "deletedAt" timestamp with time zone
);


ALTER TABLE public.actions OWNER TO postgres;

--
-- Name: actions_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.actions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.actions_id_seq OWNER TO postgres;

--
-- Name: actions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.actions_id_seq OWNED BY public.actions.id;


--
-- Name: attrGroups; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public."attrGroups" (
    identifier character varying(250) NOT NULL,
    name jsonb NOT NULL,
    "order" integer NOT NULL,
    visible boolean NOT NULL,
    id integer NOT NULL,
    "tenantId" character varying(50) NOT NULL,
    "createdBy" character varying(250) NOT NULL,
    "updatedBy" character varying(250) NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "deletedAt" timestamp with time zone,
    options jsonb DEFAULT '[]'::jsonb
);


ALTER TABLE public."attrGroups" OWNER TO postgres;

--
-- Name: attrGroups_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public."attrGroups_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."attrGroups_id_seq" OWNER TO postgres;

--
-- Name: attrGroups_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public."attrGroups_id_seq" OWNED BY public."attrGroups".id;


--
-- Name: attributes; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.attributes (
    identifier character varying(250) NOT NULL,
    name jsonb NOT NULL,
    "order" integer NOT NULL,
    valid jsonb,
    visible jsonb,
    relations jsonb,
    "languageDependent" boolean NOT NULL,
    type integer NOT NULL,
    pattern character varying(250),
    "errorMessage" jsonb,
    lov integer,
    "richText" boolean NOT NULL,
    "multiLine" boolean NOT NULL,
    id integer NOT NULL,
    "tenantId" character varying(50) NOT NULL,
    "createdBy" character varying(250) NOT NULL,
    "updatedBy" character varying(250) NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "deletedAt" timestamp with time zone,
    options jsonb DEFAULT '[]'::jsonb
);


ALTER TABLE public.attributes OWNER TO postgres;

--
-- Name: attributes_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.attributes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.attributes_id_seq OWNER TO postgres;

--
-- Name: attributes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.attributes_id_seq OWNED BY public.attributes.id;


--
-- Name: channels_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.channels_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.channels_id_seq OWNER TO postgres;

--
-- Name: channels; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.channels (
    identifier character varying(250) NOT NULL,
    name jsonb NOT NULL,
    active boolean NOT NULL,
    type integer NOT NULL,
    valid jsonb,
    visible jsonb,
    config jsonb NOT NULL,
    mappings jsonb NOT NULL,
    runtime jsonb NOT NULL,
    id integer DEFAULT nextval('public.channels_id_seq'::regclass) NOT NULL,
    "tenantId" character varying(50) NOT NULL,
    "createdBy" character varying(250) NOT NULL,
    "updatedBy" character varying(250) NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "deletedAt" timestamp with time zone
);


ALTER TABLE public.channels OWNER TO postgres;

--
-- Name: channels_exec_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.channels_exec_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.channels_exec_id_seq OWNER TO postgres;

--
-- Name: channels_exec; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.channels_exec (
    "channelId" integer NOT NULL,
    status integer NOT NULL,
    "startTime" timestamp with time zone NOT NULL,
    "finishTime" timestamp with time zone,
    "storagePath" character varying(255),
    log jsonb,
    id integer DEFAULT nextval('public.channels_exec_id_seq'::regclass) NOT NULL,
    "tenantId" character varying(50) NOT NULL,
    "createdBy" character varying(250) NOT NULL,
    "updatedBy" character varying(250) NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "deletedAt" timestamp with time zone
);


ALTER TABLE public.channels_exec OWNER TO postgres;

--
-- Name: dashboards; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.dashboards (
    identifier character varying(250) NOT NULL,
    name jsonb NOT NULL,
    users jsonb NOT NULL,
    components jsonb NOT NULL,
    id integer NOT NULL,
    "tenantId" character varying(50) NOT NULL,
    "createdBy" character varying(250) NOT NULL,
    "updatedBy" character varying(250) NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "deletedAt" timestamp with time zone
);


ALTER TABLE public.dashboards OWNER TO postgres;

--
-- Name: dashboards_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.dashboards_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.dashboards_id_seq OWNER TO postgres;

--
-- Name: dashboards_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.dashboards_id_seq OWNED BY public.dashboards.id;


--
-- Name: group_attribute; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.group_attribute (
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "AttrGroupId" integer NOT NULL,
    "AttributeId" integer NOT NULL
);


ALTER TABLE public.group_attribute OWNER TO postgres;

--
-- Name: identifier_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.identifier_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.identifier_seq OWNER TO postgres;

--
-- Name: itemRelations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public."itemRelations" (
    identifier character varying(250) NOT NULL,
    "itemId" integer NOT NULL,
    "itemIdentifier" character varying(250) NOT NULL,
    "relationId" integer NOT NULL,
    "relationIdentifier" character varying(250) NOT NULL,
    "targetId" integer NOT NULL,
    "targetIdentifier" character varying(250) NOT NULL,
    "values" jsonb,
    id integer NOT NULL,
    "tenantId" character varying(50) NOT NULL,
    "createdBy" character varying(250) NOT NULL,
    "updatedBy" character varying(250) NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "deletedAt" timestamp with time zone
);


ALTER TABLE public."itemRelations" OWNER TO postgres;

--
-- Name: itemRelations_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public."itemRelations_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."itemRelations_id_seq" OWNER TO postgres;

--
-- Name: itemRelations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public."itemRelations_id_seq" OWNED BY public."itemRelations".id;


--
-- Name: items; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.items (
    identifier character varying(250) NOT NULL,
    path public.ltree NOT NULL,
    name jsonb NOT NULL,
    "typeId" integer NOT NULL,
    "typeIdentifier" character varying(250) NOT NULL,
    "parentIdentifier" character varying(250) NOT NULL,
    "values" jsonb,
    "fileOrigName" character varying(250) NOT NULL,
    "storagePath" character varying(500) NOT NULL,
    "mimeType" character varying(250) NOT NULL,
    id integer NOT NULL,
    "tenantId" character varying(50) NOT NULL,
    "createdBy" character varying(250) NOT NULL,
    "updatedBy" character varying(250) NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "deletedAt" timestamp with time zone,
    channels jsonb DEFAULT '{}'::jsonb
);


ALTER TABLE public.items OWNER TO postgres;

--
-- Name: items_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.items_id_seq OWNER TO postgres;

--
-- Name: items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.items_id_seq OWNED BY public.items.id;


--
-- Name: languages; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.languages (
    identifier character varying(250) NOT NULL,
    name jsonb NOT NULL,
    id integer NOT NULL,
    "tenantId" character varying(50) NOT NULL,
    "createdBy" character varying(250) NOT NULL,
    "updatedBy" character varying(250) NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "deletedAt" timestamp with time zone
);


ALTER TABLE public.languages OWNER TO postgres;

--
-- Name: languages_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.languages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.languages_id_seq OWNER TO postgres;

--
-- Name: languages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.languages_id_seq OWNED BY public.languages.id;


--
-- Name: lovs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.lovs (
    identifier character varying(250) NOT NULL,
    name jsonb NOT NULL,
    "values" jsonb NOT NULL,
    id integer NOT NULL,
    "tenantId" character varying(50) NOT NULL,
    "createdBy" character varying(250) NOT NULL,
    "updatedBy" character varying(250) NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "deletedAt" timestamp with time zone
);


ALTER TABLE public.lovs OWNER TO postgres;

--
-- Name: lovs_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.lovs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.lovs_id_seq OWNER TO postgres;

--
-- Name: lovs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.lovs_id_seq OWNED BY public.lovs.id;


--
-- Name: relations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.relations (
    identifier character varying(250) NOT NULL,
    name jsonb NOT NULL,
    sources jsonb,
    targets jsonb,
    child boolean NOT NULL,
    multi boolean NOT NULL,
    id integer NOT NULL,
    "tenantId" character varying(50) NOT NULL,
    "createdBy" character varying(250) NOT NULL,
    "updatedBy" character varying(250) NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "deletedAt" timestamp with time zone,
    "order" integer DEFAULT 0,
    options jsonb DEFAULT '[]'::jsonb
);


ALTER TABLE public.relations OWNER TO postgres;

--
-- Name: relations_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.relations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.relations_id_seq OWNER TO postgres;

--
-- Name: relations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.relations_id_seq OWNED BY public.relations.id;


--
-- Name: roles; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.roles (
    identifier character varying(250) NOT NULL,
    name character varying(250) NOT NULL,
    "configAccess" jsonb NOT NULL,
    "relAccess" jsonb NOT NULL,
    "itemAccess" jsonb NOT NULL,
    "otherAccess" jsonb NOT NULL,
    id integer NOT NULL,
    "tenantId" character varying(50) NOT NULL,
    "createdBy" character varying(250) NOT NULL,
    "updatedBy" character varying(250) NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "deletedAt" timestamp with time zone,
    "channelAccess" jsonb DEFAULT '[]'::jsonb,
    options jsonb DEFAULT '[]'::jsonb
);


ALTER TABLE public.roles OWNER TO postgres;

--
-- Name: roles_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.roles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.roles_id_seq OWNER TO postgres;

--
-- Name: roles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.roles_id_seq OWNED BY public.roles.id;


--
-- Name: savedColumns; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public."savedColumns" (
    identifier character varying(250) NOT NULL,
    name jsonb NOT NULL,
    public boolean NOT NULL,
    columns jsonb NOT NULL,
    "user" character varying(250) NOT NULL,
    id integer NOT NULL,
    "tenantId" character varying(50) NOT NULL,
    "createdBy" character varying(250) NOT NULL,
    "updatedBy" character varying(250) NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "deletedAt" timestamp with time zone
);


ALTER TABLE public."savedColumns" OWNER TO postgres;

--
-- Name: savedColumns_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public."savedColumns_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."savedColumns_id_seq" OWNER TO postgres;

--
-- Name: savedColumns_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public."savedColumns_id_seq" OWNED BY public."savedColumns".id;


--
-- Name: savedSearch; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public."savedSearch" (
    identifier character varying(250) NOT NULL,
    name jsonb NOT NULL,
    public boolean NOT NULL,
    extended boolean NOT NULL,
    filters jsonb NOT NULL,
    "whereClause" jsonb NOT NULL,
    "user" character varying(250) NOT NULL,
    id integer NOT NULL,
    "tenantId" character varying(50) NOT NULL,
    "createdBy" character varying(250) NOT NULL,
    "updatedBy" character varying(250) NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "deletedAt" timestamp with time zone
);


ALTER TABLE public."savedSearch" OWNER TO postgres;

--
-- Name: savedSearch_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public."savedSearch_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public."savedSearch_id_seq" OWNER TO postgres;

--
-- Name: savedSearch_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public."savedSearch_id_seq" OWNED BY public."savedSearch".id;


--
-- Name: types; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.types (
    path public.ltree NOT NULL,
    identifier character varying(250) NOT NULL,
    link integer NOT NULL,
    name jsonb NOT NULL,
    icon character varying(50),
    "iconColor" character varying(50),
    file boolean NOT NULL,
    "mainImage" integer NOT NULL,
    images jsonb NOT NULL,
    id integer NOT NULL,
    "tenantId" character varying(50) NOT NULL,
    "createdBy" character varying(250) NOT NULL,
    "updatedBy" character varying(250) NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "deletedAt" timestamp with time zone,
    options jsonb DEFAULT '[]'::jsonb
);


ALTER TABLE public.types OWNER TO postgres;

--
-- Name: types_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.types_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.types_id_seq OWNER TO postgres;

--
-- Name: types_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.types_id_seq OWNED BY public.types.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.users (
    login character varying(250) NOT NULL,
    name character varying(250) NOT NULL,
    password character varying(250) NOT NULL,
    email character varying(250),
    props jsonb,
    roles jsonb NOT NULL,
    id integer NOT NULL,
    "tenantId" character varying(50) NOT NULL,
    "createdBy" character varying(250) NOT NULL,
    "updatedBy" character varying(250) NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "deletedAt" timestamp with time zone,
    options jsonb DEFAULT '[]'::jsonb
);


ALTER TABLE public.users OWNER TO postgres;

--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.users_id_seq OWNER TO postgres;

--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: actions id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.actions ALTER COLUMN id SET DEFAULT nextval('public.actions_id_seq'::regclass);


--
-- Name: attrGroups id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."attrGroups" ALTER COLUMN id SET DEFAULT nextval('public."attrGroups_id_seq"'::regclass);


--
-- Name: attributes id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.attributes ALTER COLUMN id SET DEFAULT nextval('public.attributes_id_seq'::regclass);


--
-- Name: dashboards id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dashboards ALTER COLUMN id SET DEFAULT nextval('public.dashboards_id_seq'::regclass);


--
-- Name: itemRelations id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."itemRelations" ALTER COLUMN id SET DEFAULT nextval('public."itemRelations_id_seq"'::regclass);


--
-- Name: items id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.items ALTER COLUMN id SET DEFAULT nextval('public.items_id_seq'::regclass);


--
-- Name: languages id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.languages ALTER COLUMN id SET DEFAULT nextval('public.languages_id_seq'::regclass);


--
-- Name: lovs id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.lovs ALTER COLUMN id SET DEFAULT nextval('public.lovs_id_seq'::regclass);


--
-- Name: relations id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.relations ALTER COLUMN id SET DEFAULT nextval('public.relations_id_seq'::regclass);


--
-- Name: roles id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.roles ALTER COLUMN id SET DEFAULT nextval('public.roles_id_seq'::regclass);


--
-- Name: savedColumns id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."savedColumns" ALTER COLUMN id SET DEFAULT nextval('public."savedColumns_id_seq"'::regclass);


--
-- Name: savedSearch id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."savedSearch" ALTER COLUMN id SET DEFAULT nextval('public."savedSearch_id_seq"'::regclass);


--
-- Name: types id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.types ALTER COLUMN id SET DEFAULT nextval('public.types_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Data for Name: actions; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.actions (identifier, name, code, triggers, id, "tenantId", "createdBy", "updatedBy", "createdAt", "updatedAt", "deletedAt") FROM stdin;
\.


--
-- Data for Name: attrGroups; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public."attrGroups" (identifier, name, "order", visible, id, "tenantId", "createdBy", "updatedBy", "createdAt", "updatedAt", "deletedAt", options) FROM stdin;
\.


--
-- Data for Name: attributes; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.attributes (identifier, name, "order", valid, visible, relations, "languageDependent", type, pattern, "errorMessage", lov, "richText", "multiLine", id, "tenantId", "createdBy", "updatedBy", "createdAt", "updatedAt", "deletedAt", options) FROM stdin;
\.


--
-- Data for Name: channels; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.channels (identifier, name, active, type, valid, visible, config, mappings, runtime, id, "tenantId", "createdBy", "updatedBy", "createdAt", "updatedAt", "deletedAt") FROM stdin;
\.


--
-- Data for Name: channels_exec; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.channels_exec ("channelId", status, "startTime", "finishTime", "storagePath", log, id, "tenantId", "createdBy", "updatedBy", "createdAt", "updatedAt", "deletedAt") FROM stdin;
\.


--
-- Data for Name: dashboards; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.dashboards (identifier, name, users, components, id, "tenantId", "createdBy", "updatedBy", "createdAt", "updatedAt", "deletedAt") FROM stdin;
\.


--
-- Data for Name: group_attribute; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.group_attribute ("createdAt", "updatedAt", "AttrGroupId", "AttributeId") FROM stdin;
\.


--
-- Data for Name: itemRelations; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public."itemRelations" (identifier, "itemId", "itemIdentifier", "relationId", "relationIdentifier", "targetId", "targetIdentifier", "values", id, "tenantId", "createdBy", "updatedBy", "createdAt", "updatedAt", "deletedAt") FROM stdin;
\.


--
-- Data for Name: items; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.items (identifier, path, name, "typeId", "typeIdentifier", "parentIdentifier", "values", "fileOrigName", "storagePath", "mimeType", id, "tenantId", "createdBy", "updatedBy", "createdAt", "updatedAt", "deletedAt", channels) FROM stdin;
\.


--
-- Data for Name: languages; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.languages (identifier, name, id, "tenantId", "createdBy", "updatedBy", "createdAt", "updatedAt", "deletedAt") FROM stdin;
en	{"en": "English"}	1	default	system	system	2020-09-16 14:22:49.124158+03	2020-09-16 14:22:49.124158+03	\N
\.


--
-- Data for Name: lovs; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.lovs (identifier, name, "values", id, "tenantId", "createdBy", "updatedBy", "createdAt", "updatedAt", "deletedAt") FROM stdin;
\.


--
-- Data for Name: relations; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.relations (identifier, name, sources, targets, child, multi, id, "tenantId", "createdBy", "updatedBy", "createdAt", "updatedAt", "deletedAt", "order", options) FROM stdin;
\.


--
-- Data for Name: roles; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.roles (identifier, name, "configAccess", "relAccess", "itemAccess", "otherAccess", id, "tenantId", "createdBy", "updatedBy", "createdAt", "updatedAt", "deletedAt", "channelAccess", options) FROM stdin;
user	User	{"lovs": 0, "roles": 0, "types": 0, "users": 0, "actions": 0, "channels": 0, "languages": 0, "relations": 0, "attributes": 0, "dashboards": 0}	{"access": 0, "groups": [], "relations": []}	{"valid": [], "access": 0, "groups": [], "fromItems": []}	{"audit": false, "search": true, "exportCSV": true, "exportXLS": true, "importXLS": false}	2	default	system	system	2020-09-16 14:23:32.909034+03	2020-09-16 14:23:32.909034+03	\N	[]	[]
admin	Administrator	{"lovs": 2, "roles": 2, "types": 2, "users": 2, "actions": 2, "channels": 2, "languages": 2, "relations": 2, "attributes": 2, "dashboards": 2}	{"access": 0, "groups": [], "relations": []}	{"valid": [], "access": 0, "groups": [], "fromItems": []}	{"audit": true, "search": true, "exportCSV": true, "exportXLS": true, "importXLS": true}	1	default	system	system	2020-09-16 14:23:32.909034+03	2020-09-16 14:23:32.909034+03	\N	[]	[]
\.


--
-- Data for Name: savedColumns; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public."savedColumns" (identifier, name, public, columns, "user", id, "tenantId", "createdBy", "updatedBy", "createdAt", "updatedAt", "deletedAt") FROM stdin;
\.


--
-- Data for Name: savedSearch; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public."savedSearch" (identifier, name, public, extended, filters, "whereClause", "user", id, "tenantId", "createdBy", "updatedBy", "createdAt", "updatedAt", "deletedAt") FROM stdin;
\.


--
-- Data for Name: types; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.types (path, identifier, link, name, icon, "iconColor", file, "mainImage", images, id, "tenantId", "createdBy", "updatedBy", "createdAt", "updatedAt", "deletedAt", options) FROM stdin;
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.users (login, name, password, email, props, roles, id, "tenantId", "createdBy", "updatedBy", "createdAt", "updatedAt", "deletedAt", options) FROM stdin;
admin	Administrator	$2b$10$WtKEm5gspljprGVuHAj4QeO.QwzWiDmdEFN9VzXRbxyrSpQi9m4Fq	\N	\N	[1]	1	default	system	system	2020-09-16 14:24:07.636836+03	2020-09-16 14:24:07.636836+03	\N	[]
\.


--
-- Name: actions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.actions_id_seq', 1, false);


--
-- Name: attrGroups_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public."attrGroups_id_seq"', 1, false);


--
-- Name: attributes_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.attributes_id_seq', 1, false);


--
-- Name: channels_exec_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.channels_exec_id_seq', 1, false);


--
-- Name: channels_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.channels_id_seq', 1, false);


--
-- Name: dashboards_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.dashboards_id_seq', 1, false);


--
-- Name: identifier_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.identifier_seq', 1, false);


--
-- Name: itemRelations_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public."itemRelations_id_seq"', 1, false);


--
-- Name: items_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.items_id_seq', 1, false);


--
-- Name: languages_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.languages_id_seq', 1, true);


--
-- Name: lovs_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.lovs_id_seq', 1, false);


--
-- Name: relations_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.relations_id_seq', 1, false);


--
-- Name: roles_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.roles_id_seq', 2, true);


--
-- Name: savedColumns_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public."savedColumns_id_seq"', 1, true);


--
-- Name: savedSearch_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public."savedSearch_id_seq"', 1, false);


--
-- Name: types_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.types_id_seq', 1, false);


--
-- Name: users_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.users_id_seq', 1, true);


--
-- Name: actions actions_identifier_tenantId_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.actions
    ADD CONSTRAINT "actions_identifier_tenantId_key" UNIQUE (identifier, "tenantId");


--
-- Name: actions actions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.actions
    ADD CONSTRAINT actions_pkey PRIMARY KEY (id);


--
-- Name: attrGroups attrGroups_identifier_tenantId_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."attrGroups"
    ADD CONSTRAINT "attrGroups_identifier_tenantId_key" UNIQUE (identifier, "tenantId");


--
-- Name: attrGroups attrGroups_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."attrGroups"
    ADD CONSTRAINT "attrGroups_pkey" PRIMARY KEY (id);


--
-- Name: attributes attributes_identifier_tenantId_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.attributes
    ADD CONSTRAINT "attributes_identifier_tenantId_key" UNIQUE (identifier, "tenantId");


--
-- Name: attributes attributes_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.attributes
    ADD CONSTRAINT attributes_pkey PRIMARY KEY (id);


--
-- Name: channels_exec channels_exec_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.channels_exec
    ADD CONSTRAINT channels_exec_pkey PRIMARY KEY (id);


--
-- Name: channels channels_identifier_tenantId_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT "channels_identifier_tenantId_key" UNIQUE (identifier, "tenantId");


--
-- Name: channels channels_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_pkey PRIMARY KEY (id);


--
-- Name: dashboards dashboards_identifier_tenantId_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dashboards
    ADD CONSTRAINT "dashboards_identifier_tenantId_key" UNIQUE (identifier, "tenantId");


--
-- Name: dashboards dashboards_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dashboards
    ADD CONSTRAINT dashboards_pkey PRIMARY KEY (id);


--
-- Name: group_attribute group_attribute_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.group_attribute
    ADD CONSTRAINT group_attribute_pkey PRIMARY KEY ("AttrGroupId", "AttributeId");


--
-- Name: itemRelations itemRelations_identifier_tenantId_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."itemRelations"
    ADD CONSTRAINT "itemRelations_identifier_tenantId_key" UNIQUE (identifier, "tenantId");


--
-- Name: itemRelations itemRelations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."itemRelations"
    ADD CONSTRAINT "itemRelations_pkey" PRIMARY KEY (id);


--
-- Name: items items_identifier_tenantId_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.items
    ADD CONSTRAINT "items_identifier_tenantId_key" UNIQUE (identifier, "tenantId");


--
-- Name: items items_path_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_path_key UNIQUE (path);


--
-- Name: items items_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_pkey PRIMARY KEY (id);


--
-- Name: languages languages_identifier_tenantId_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.languages
    ADD CONSTRAINT "languages_identifier_tenantId_key" UNIQUE (identifier, "tenantId");


--
-- Name: languages languages_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.languages
    ADD CONSTRAINT languages_pkey PRIMARY KEY (id);


--
-- Name: lovs lovs_identifier_tenantId_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.lovs
    ADD CONSTRAINT "lovs_identifier_tenantId_key" UNIQUE (identifier, "tenantId");


--
-- Name: lovs lovs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.lovs
    ADD CONSTRAINT lovs_pkey PRIMARY KEY (id);


--
-- Name: relations relations_identifier_tenantId_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.relations
    ADD CONSTRAINT "relations_identifier_tenantId_key" UNIQUE (identifier, "tenantId");


--
-- Name: relations relations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.relations
    ADD CONSTRAINT relations_pkey PRIMARY KEY (id);


--
-- Name: roles roles_identifier_tenantId_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT "roles_identifier_tenantId_key" UNIQUE (identifier, "tenantId");


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);


--
-- Name: savedColumns savedColumns_identifier_tenantId_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."savedColumns"
    ADD CONSTRAINT "savedColumns_identifier_tenantId_key" UNIQUE (identifier, "tenantId");


--
-- Name: savedColumns savedColumns_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."savedColumns"
    ADD CONSTRAINT "savedColumns_pkey" PRIMARY KEY (id);


--
-- Name: savedSearch savedSearch_identifier_tenantId_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."savedSearch"
    ADD CONSTRAINT "savedSearch_identifier_tenantId_key" UNIQUE (identifier, "tenantId");


--
-- Name: savedSearch savedSearch_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."savedSearch"
    ADD CONSTRAINT "savedSearch_pkey" PRIMARY KEY (id);


--
-- Name: types types_identifier_tenantId_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.types
    ADD CONSTRAINT "types_identifier_tenantId_key" UNIQUE (identifier, "tenantId");


--
-- Name: types types_path_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.types
    ADD CONSTRAINT types_path_key UNIQUE (path);


--
-- Name: types types_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.types
    ADD CONSTRAINT types_pkey PRIMARY KEY (id);


--
-- Name: users users_login_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_login_key UNIQUE (login);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: group_attribute group_attribute_AttrGroupId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.group_attribute
    ADD CONSTRAINT "group_attribute_AttrGroupId_fkey" FOREIGN KEY ("AttrGroupId") REFERENCES public."attrGroups"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: group_attribute group_attribute_AttributeId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.group_attribute
    ADD CONSTRAINT "group_attribute_AttributeId_fkey" FOREIGN KEY ("AttributeId") REFERENCES public.attributes(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

--
-- v1.5
--

ALTER TABLE "actions" 
    ADD COLUMN "order" integer;

ALTER TABLE "savedSearch" 
    ADD COLUMN "entity" varchar(50);