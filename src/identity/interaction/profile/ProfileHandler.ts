import { DataFactory } from 'n3';
import type { Quad } from '@rdfjs/types';
import { getLoggerFor } from '@solid/community-server/logging/LogUtil';
import { BadRequestHttpError } from '@solid/community-server/util/errors/BadRequestHttpError';
import { NotFoundHttpError } from '@solid/community-server/util/errors/NotFoundHttpError';
import { createErrorMessage } from '@solid/community-server/util/errors/ErrorUtil';
import { isUrl } from '@solid/community-server/util/StringUtil';
import { parseQuads, serializeQuads } from '@solid/community-server/util/QuadUtil';
import { TEXT_N3, TEXT_TURTLE } from '@solid/community-server/util/ContentTypes';
import { guardedStreamFrom } from '@solid/community-server/util/StreamUtil';
import { BasicRepresentation } from '@solid/community-server/http/representation/BasicRepresentation';
import type { JsonRepresentation } from '@solid/community-server/identity/interaction/InteractionUtil';
import type { Json } from '@solid/community-server/util/Json';
import Dict = NodeJS.Dict;
import { JsonInteractionHandler } from '@solid/community-server/identity/interaction/JsonInteractionHandler';
import type { JsonInteractionHandlerInput } from '@solid/community-server/identity/interaction/JsonInteractionHandler';
import type { JsonView } from '@solid/community-server/identity/interaction/JsonView';
import { assertAccountId } from '@solid/community-server/identity/interaction/account/util/AccountUtil';
import type { ResourceStore } from '@solid/community-server/dist/storage/ResourceStore';
import type { WebIdStore } from '@solid/community-server/dist/identity/interaction/webid/util/WebIdStore';
import type { PasswordStore } from '@solid/community-server/dist/identity/interaction/password/util/PasswordStore';
import { RepresentationMetadata } from '@solid/community-server/dist/http/representation/RepresentationMetadata';
import type { N3Patch } from '@solid/community-server/dist/http/representation/N3Patch';
import { v4 } from 'uuid';

// RDF Vocabulary namespaces
const FOAF = 'http://xmlns.com/foaf/0.1/';
const VCARD = 'http://www.w3.org/2006/vcard/ns#';
const SCHEMA = 'http://schema.org/';
const SOLID = 'http://www.w3.org/ns/solid/terms#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const ORG = 'http://www.w3.org/ns/org#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';

// Profile data type matching SolidOS profile schema
export type ProfileData = Dict<Json> & {
  // Style
  profileBackgroundColor?: string;
  profileHighlightColor?: string;

  // Basic info
  name?: string;
  nickname?: string;
  email?: string; // Read-only, from account
  phone?: string;

  // Contacts/Friends (array of WebIDs)
  knows?: string[];

  // Pronouns
  preferredSubjectPronoun?: string;
  preferredObjectPronoun?: string;
  preferredRelativePronoun?: string;

  // Photo (can be URL, base64 data URI, or file upload)
  photo?: string;
  // If photo is base64, this indicates the image format
  photoFormat?: string;

  // Homepage
  homepage?: string;

  // Languages (array of language URIs)
  knowsLanguage?: string[];

  // Social media accounts (array of account objects)
  accounts?: {
    type: string;
    accountName: string;
    accountServiceHomepage?: string;
    icon?: string;
    label?: string;
  }[];

  // Skills (array of skill URIs)
  skills?: string[];

  // CV/Organizations (array of organization memberships)
  organizations?: {
    organization?: string; // Can be URI or name
    organizationName?: string; // Plain text name (alternative to URI)
    role?: string;
    startDate?: string;
    endDate?: string;
    description?: string;
    roleType?: 'CurrentRole' | 'PastRole' | 'FutureRole';
  }[];
};

/**
 * Validation result
 */
interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates profile data
 */
function validateProfileData(data: unknown): ValidationResult {
  const errors: string[] = [];

  if (typeof data !== 'object' || data === null) {
    return { valid: false, errors: [ 'Profile data must be an object' ]};
  }

  const profile = data as Record<string, unknown>;

  // Validate colors (hex format)
  if (profile.profileBackgroundColor !== undefined && (typeof profile.profileBackgroundColor !== 'string' || !/^#[\da-f]{6}$/i.test(profile.profileBackgroundColor))) {
    errors.push('profileBackgroundColor must be a valid hex color (e.g., #ffffff)');
  }

  if (profile.profileHighlightColor !== undefined && (typeof profile.profileHighlightColor !== 'string' || !/^#[\da-f]{6}$/i.test(profile.profileHighlightColor))) {
    errors.push('profileHighlightColor must be a valid hex color (e.g., #000000)');
  }

  // Validate photo (URL or base64 data URI)
  if (profile.photo !== undefined && profile.photo !== null && profile.photo !== '') {
    if (typeof profile.photo === 'string') {
      const isValidUrl = isUrl(profile.photo);
      const isBase64 = /^data:image\/(jpeg|jpg|png|gif|webp);base64,/.test(profile.photo);
      if (!isValidUrl && !isBase64) {
        errors.push('photo must be a valid URL or base64 data URI (data:image/...;base64,...)');
      }
    } else {
      errors.push('photo must be a string');
    }
  }

  if (profile.homepage !== undefined && profile.homepage !== null && profile.homepage !== '' && (typeof profile.homepage !== 'string' || !isUrl(profile.homepage))) {
    errors.push('homepage must be a valid URL');
  }

  // Validate arrays
  if (profile.knowsLanguage !== undefined && !Array.isArray(profile.knowsLanguage)) {
    errors.push('knowsLanguage must be an array');
  }

  if (profile.skills !== undefined && !Array.isArray(profile.skills)) {
    errors.push('skills must be an array');
  }

  if (profile.accounts !== undefined && !Array.isArray(profile.accounts)) {
    errors.push('accounts must be an array');
  }

  if (profile.organizations !== undefined && !Array.isArray(profile.organizations)) {
    errors.push('organizations must be an array');
  }

  if (profile.knows !== undefined && !Array.isArray(profile.knows)) {
    errors.push('knows must be an array');
  }

  // Validate phone number format (basic validation)
  if (profile.phone !== undefined && profile.phone !== null && profile.phone !== '' && typeof profile.phone !== 'string') {
    errors.push('phone must be a string');
  }

  // Validate WebIDs in knows array
  if (profile.knows && Array.isArray(profile.knows)) {
    for (const webId of profile.knows) {
      if (typeof webId !== 'string' || !isUrl(webId)) {
        errors.push(`Invalid WebID in knows array: ${webId}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Extracts profile data from RDF quads
 */
function extractProfileFromQuads(quads: Quad[], webId: string): ProfileData {
  const profile: ProfileData = {};
  const webIdNode = DataFactory.namedNode(webId);

  for (const quad of quads) {
    if (!quad.subject.equals(webIdNode)) {
      continue;
    }

    const predicate = quad.predicate.value;
    const object = quad.object;

    // Style
    if (predicate === `${SOLID}profileBackgroundColor`) {
      profile.profileBackgroundColor = object.value;
    } else if (predicate === `${SOLID}profileHighlightColor`) {
      profile.profileHighlightColor = object.value;
    }
    // Basic info
    else if (predicate === `${FOAF}name`) {
      profile.name = object.value;
    } else if (predicate === `${FOAF}nick`) {
      profile.nickname = object.value;
    }
    // Email (foaf:mbox is mailto:email@example.com format)
    else if (predicate === `${FOAF}mbox` || predicate === `${VCARD}hasEmail`) {
      const emailValue = object.value;
      // Extract email from mailto: URI if needed
      if (emailValue.startsWith('mailto:')) {
        profile.email = emailValue.slice(7);
      } else {
        profile.email = emailValue;
      }
    }
    // Phone
    else if (predicate === `${VCARD}hasTelephone`) {
      profile.phone = object.value;
    }
    // Contacts/Friends
    else if (predicate === `${FOAF}knows`) {
      if (!profile.knows) {
        profile.knows = [];
      }
      profile.knows.push(object.value);
    }
    // Pronouns
    else if (predicate === `${SOLID}preferredSubjectPronoun`) {
      profile.preferredSubjectPronoun = object.value;
    } else if (predicate === `${SOLID}preferredObjectPronoun`) {
      profile.preferredObjectPronoun = object.value;
    } else if (predicate === `${SOLID}preferredRelativePronoun`) {
      profile.preferredRelativePronoun = object.value;
    }
    // Photo
    else if (predicate === `${VCARD}hasPhoto` || predicate === `${FOAF}img` || predicate === `${FOAF}depiction`) {
      profile.photo = object.value;
    }
    // Homepage
    else if (predicate === `${FOAF}homepage`) {
      profile.homepage = object.value;
    }
    // Languages
    else if (predicate === `${SCHEMA}knowsLanguage`) {
      if (!profile.knowsLanguage) {
        profile.knowsLanguage = [];
      }
      profile.knowsLanguage.push(object.value);
    }
    // Skills
    else if (predicate === `${SCHEMA}skills`) {
      if (!profile.skills) {
        profile.skills = [];
      }
      profile.skills.push(object.value);
    }
  }

  // Extract organizations (org:member relationships)
  // Find all role nodes that have org:member pointing to this WebID
  const roleNodes = new Set<string>();
  for (const quad of quads) {
    if (quad.predicate.value === `${ORG}member` && quad.object.equals(webIdNode)) {
      // Quad.subject is the role node
      roleNodes.add(quad.subject.value);
    }
  }

  // For each role node, extract organization details
  if (roleNodes.size > 0) {
    profile.organizations = [];
    for (const roleNodeValue of roleNodes) {
      const orgEntry: { organization?: string; organizationName?: string; role?: string; startDate?: string; endDate?: string; description?: string; roleType?: 'CurrentRole' | 'PastRole' | 'FutureRole' } = {};
      const roleNode = DataFactory.namedNode(roleNodeValue);

      for (const quad of quads) {
        if (!quad.subject.equals(roleNode)) {
          continue;
        }

        const predicate = quad.predicate.value;
        const object = quad.object;

        if (predicate === `${ORG}organization`) {
          // Organization can be a URI or blank node
          if (object.termType === 'NamedNode') {
            orgEntry.organization = object.value;
          } else if (object.termType === 'BlankNode') {
            // Find the name of this organization blank node
            for (const orgQuad of quads) {
              if (orgQuad.subject.equals(object) && orgQuad.predicate.value === `${SCHEMA}name`) {
                orgEntry.organizationName = orgQuad.object.value;
                break;
              }
            }
          }
        } else if (predicate === `${VCARD}role`) {
          orgEntry.role = object.value;
        } else if (predicate === `${SCHEMA}startDate`) {
          orgEntry.startDate = object.value;
        } else if (predicate === `${SCHEMA}endDate`) {
          orgEntry.endDate = object.value;
        } else if (predicate === `${SCHEMA}description`) {
          orgEntry.description = object.value;
        } else if (predicate === `${RDF}type`) {
          // Check if it's a role type (CurrentRole, PastRole, FutureRole)
          const typeValue = object.value;
          if (typeValue.includes('CurrentRole')) {
            orgEntry.roleType = 'CurrentRole';
          } else if (typeValue.includes('PastRole')) {
            orgEntry.roleType = 'PastRole';
          } else if (typeValue.includes('FutureRole')) {
            orgEntry.roleType = 'FutureRole';
          }
        }
      }

      // Only add if we have at least organization or role
      if (orgEntry.organization || orgEntry.organizationName || orgEntry.role) {
        profile.organizations.push(orgEntry);
      }
    }
  }

  return profile;
}

/**
 * Creates an N3 patch serialization string
 * Format matches test examples exactly: <> a solid:InsertDeletePatch; solid:inserts { ... }; solid:deletes { ... }.
 */
function createN3PatchString(deletes: Quad[], inserts: Quad[], conditions: Quad[]): string {
  const solid = 'http://www.w3.org/ns/solid/terms#';
  const rdf = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

  let n3 = `@prefix solid: <${solid}>.\n@prefix rdf: <${rdf}>.\n\n`;
  n3 += `<> a solid:InsertDeletePatch`;

  const parts: string[] = [];

  if (deletes.length > 0) {
    let deletesPart = `  solid:deletes {\n`;
    for (const quad of deletes) {
      deletesPart += `    ${quadToString(quad)}.\n`;
    }
    deletesPart += `  }`;
    parts.push(deletesPart);
  }

  if (inserts.length > 0) {
    let insertsPart = `  solid:inserts {\n`;
    for (const quad of inserts) {
      insertsPart += `    ${quadToString(quad)}.\n`;
    }
    insertsPart += `  }`;
    parts.push(insertsPart);
  }

  if (conditions.length > 0) {
    let wherePart = `  solid:where {\n`;
    for (const quad of conditions) {
      wherePart += `    ${quadToString(quad)}.\n`;
    }
    wherePart += `  }`;
    parts.push(wherePart);
  }

  if (parts.length > 0) {
    n3 += `;\n${parts.join(';\n')}.`;
  } else {
    n3 += '.';
  }

  return n3;
}

/**
 * Converts a quad to N3 string format
 */
function quadToString(quad: Quad): string {
  const subj = termToString(quad.subject);
  const pred = termToString(quad.predicate);
  const obj = termToString(quad.object);
  return `${subj} ${pred} ${obj}`;
}

/**
 * Converts a term to N3 string format
 */
function termToString(term: { termType: string; value: string; datatype?: { value: string }; language?: string }): string {
  if (term.termType === 'NamedNode') {
    return `<${term.value}>`;
  }
  if (term.termType === 'Literal') {
    if (term.language) {
      return `"${escapeString(term.value)}"@${term.language}`;
    }
    if (term.datatype) {
      return `"${escapeString(term.value)}"^^<${term.datatype.value}>`;
    }
    return `"${escapeString(term.value)}"`;
  }
  if (term.termType === 'BlankNode') {
    // Extract blank node ID (remove the 'b' prefix if present)
    const id = term.value.startsWith('b') ? term.value.slice(1) : term.value;
    return `_:${id}`;
  }
  if (term.termType === 'Variable') {
    return `?${term.value}`;
  }
  return term.value;
}

/**
 * Escapes special characters in strings for N3/Turtle
 */
function escapeString(str: string): string {
  return str
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t');
}

/**
 * Creates an N3 patch to update profile data
 */
function createProfilePatch(webId: string, profile: ProfileData, existingQuads: Quad[]): { deletes: Quad[]; inserts: Quad[]; conditions: Quad[] } {
  const webIdNode = DataFactory.namedNode(webId);
  const deletes: Quad[] = [];
  const inserts: Quad[] = [];

  // Properties to update
  const properties: { predicate: string; value?: string | string[] }[] = [
    { predicate: `${SOLID}profileBackgroundColor`, value: profile.profileBackgroundColor },
    { predicate: `${SOLID}profileHighlightColor`, value: profile.profileHighlightColor },
    { predicate: `${FOAF}name`, value: profile.name },
    { predicate: `${FOAF}nick`, value: profile.nickname },
    { predicate: `${VCARD}hasTelephone`, value: profile.phone },
    { predicate: `${SOLID}preferredSubjectPronoun`, value: profile.preferredSubjectPronoun },
    { predicate: `${SOLID}preferredObjectPronoun`, value: profile.preferredObjectPronoun },
    { predicate: `${SOLID}preferredRelativePronoun`, value: profile.preferredRelativePronoun },
    { predicate: `${VCARD}hasPhoto`, value: profile.photo },
    { predicate: `${FOAF}homepage`, value: profile.homepage },
    { predicate: `${SCHEMA}knowsLanguage`, value: profile.knowsLanguage },
    { predicate: `${SCHEMA}skills`, value: profile.skills },
    { predicate: `${FOAF}knows`, value: profile.knows },
  ];

  // Handle email separately (foaf:mbox uses mailto: URI format)
  const emailPred = DataFactory.namedNode(`${FOAF}mbox`);
  for (const quad of existingQuads) {
    if (quad.subject.equals(webIdNode) && quad.predicate.equals(emailPred)) {
      deletes.push(quad);
    }
  }
  // Add email from account (if available) - email is read-only from profile data but stored in RDF
  if (profile.email) {
    const emailUri = profile.email.startsWith('mailto:') ? profile.email : `mailto:${profile.email}`;
    inserts.push(DataFactory.quad(
      webIdNode,
      emailPred,
      DataFactory.namedNode(emailUri),
    ));
  }

  // Handle contacts/friends (foaf:knows)
  const knowsPred = DataFactory.namedNode(`${FOAF}knows`);
  for (const quad of existingQuads) {
    if (quad.subject.equals(webIdNode) && quad.predicate.equals(knowsPred)) {
      deletes.push(quad);
    }
  }
  if (profile.knows) {
    for (const webId of profile.knows) {
      if (webId) {
        inserts.push(DataFactory.quad(
          webIdNode,
          knowsPred,
          DataFactory.namedNode(webId),
        ));
      }
    }
  }

  // Delete existing values and insert new ones
  for (const { predicate, value } of properties) {
    const predNode = DataFactory.namedNode(predicate);

    // Delete all existing triples with this predicate
    for (const quad of existingQuads) {
      if (quad.subject.equals(webIdNode) && quad.predicate.equals(predNode)) {
        deletes.push(quad);
      }
    }

    // Insert new values
    if (value !== undefined && value !== null && value !== '') {
      if (Array.isArray(value)) {
        for (const val of value) {
          if (val) {
            inserts.push(DataFactory.quad(
              webIdNode,
              predNode,
              DataFactory.namedNode(val),
            ));
          }
        }
      } else {
        inserts.push(DataFactory.quad(
          webIdNode,
          predNode,
          DataFactory.literal(value),
        ));
      }
    }
  }

  // Handle social media accounts (foaf:account)
  const accountPred = DataFactory.namedNode(`${FOAF}account`);
  for (const quad of existingQuads) {
    if (quad.subject.equals(webIdNode) && quad.predicate.equals(accountPred)) {
      deletes.push(quad);
    }
  }

  if (profile.accounts) {
    for (const account of profile.accounts) {
      const accountNode = DataFactory.blankNode();
      inserts.push(DataFactory.quad(webIdNode, accountPred, accountNode));
      inserts.push(DataFactory.quad(accountNode, DataFactory.namedNode(`${RDF}type`), DataFactory.namedNode(`${FOAF}Account`)));
      inserts.push(DataFactory.quad(accountNode, DataFactory.namedNode(`${FOAF}accountName`), DataFactory.literal(account.accountName)));
      if (account.accountServiceHomepage) {
        inserts.push(DataFactory.quad(accountNode, DataFactory.namedNode(`${FOAF}accountServiceHomepage`), DataFactory.namedNode(account.accountServiceHomepage)));
      }
      if (account.icon) {
        inserts.push(DataFactory.quad(accountNode, DataFactory.namedNode(`${FOAF}icon`), DataFactory.namedNode(account.icon)));
      }
      if (account.label) {
        inserts.push(DataFactory.quad(accountNode, DataFactory.namedNode(`${RDFS}label`), DataFactory.literal(account.label)));
      }
    }
  }

  // Handle organizations (org:member - reverse)
  // Supports both URI and plain text organization names
  if (profile.organizations) {
    for (const org of profile.organizations) {
      // Create a role node (blank node) for this membership
      const roleNode = DataFactory.blankNode();

      // Link the role to the person
      inserts.push(DataFactory.quad(roleNode, DataFactory.namedNode(`${ORG}member`), webIdNode));

      // Handle organization - can be URI or name
      const orgValue = org.organization || org.organizationName;
      if (orgValue) {
        if (isUrl(orgValue)) {
          // If it's a URI, use it as a named node
          const orgNode = DataFactory.namedNode(orgValue);
          inserts.push(DataFactory.quad(roleNode, DataFactory.namedNode(`${ORG}organization`), orgNode));
        } else {
          // If it's a plain text name, create a blank node for the organization and add the name
          const orgNode = DataFactory.blankNode();
          inserts.push(DataFactory.quad(roleNode, DataFactory.namedNode(`${ORG}organization`), orgNode));
          inserts.push(DataFactory.quad(orgNode, DataFactory.namedNode(`${SCHEMA}name`), DataFactory.literal(orgValue)));
          inserts.push(DataFactory.quad(orgNode, DataFactory.namedNode(`${RDF}type`), DataFactory.namedNode(`${SCHEMA}Organization`)));
        }
      }

      // Add role details
      if (org.role) {
        inserts.push(DataFactory.quad(roleNode, DataFactory.namedNode(`${VCARD}role`), DataFactory.literal(org.role)));
      }
      if (org.startDate) {
        inserts.push(DataFactory.quad(roleNode, DataFactory.namedNode(`${SCHEMA}startDate`), DataFactory.literal(org.startDate)));
      }
      if (org.endDate) {
        inserts.push(DataFactory.quad(roleNode, DataFactory.namedNode(`${SCHEMA}endDate`), DataFactory.literal(org.endDate)));
      }
      if (org.description) {
        inserts.push(DataFactory.quad(roleNode, DataFactory.namedNode(`${SCHEMA}description`), DataFactory.literal(org.description)));
      }
      if (org.roleType) {
        const roleTypeUri = `${SOLID}${org.roleType}`;
        inserts.push(DataFactory.quad(roleNode, DataFactory.namedNode(`${RDF}type`), DataFactory.namedNode(roleTypeUri)));
      }
    }
  }

  return {
    deletes,
    inserts,
    conditions: [],
  };
}

/**
 * Gets the WebID profile document URL from a WebID
 * WebIDs typically have the format: http://example.com/pod/profile/card#me
 * The profile document is: http://example.com/pod/profile/card (without fragment)
 */
function getProfileDocumentUrl(webId: string): string {
  // Extract base URL from WebID (remove fragment)
  const url = new URL(webId);
  url.hash = '';
  // Ensure we return the URL without trailing issues
  return url.href;
}

/**
 * Handles the creation and updating of user profiles.
 * Stores profile data in the WebID profile document using RDF.
 */
export class ProfileHandler extends JsonInteractionHandler<ProfileData> implements JsonView {
  private readonly logger = getLoggerFor(this);

  private readonly resourceStore: ResourceStore;
  private readonly webIdStore: WebIdStore;
  private readonly passwordStore: PasswordStore;

  public constructor(resourceStore: ResourceStore, webIdStore: WebIdStore, passwordStore: PasswordStore) {
    super();
    this.resourceStore = resourceStore;
    this.webIdStore = webIdStore;
    this.passwordStore = passwordStore;
  }

  public async getView({ accountId }: JsonInteractionHandlerInput): Promise<JsonRepresentation> {
    assertAccountId(accountId);

    // Get WebID for this account
    const webIdLinks = await this.webIdStore.findLinks(accountId);
    if (webIdLinks.length === 0) {
      throw new BadRequestHttpError(
        'No WebID linked to this account. Please create a pod first by visiting the pod creation page.',
      );
    }

    // Use the first WebID (could be enhanced to let user choose)
    const webId = webIdLinks[0].webId;
    const profileDocUrl = getProfileDocumentUrl(webId);

    // Get email from account (for read-only display)
    let email: string | undefined;
    try {
      const passwordLogins = await this.passwordStore.findByAccount(accountId);
      if (passwordLogins.length > 0) {
        email = passwordLogins[0].email;
      }
    } catch (error: unknown) {
      // Email not available, continue without it
      this.logger.debug(`Could not retrieve email for account ${accountId}: ${createErrorMessage(error)}`);
    }

    try {
      // Read existing profile document
      const profileDocId = { path: profileDocUrl };
      const representation = await this.resourceStore.getRepresentation(
        profileDocId,
        { type: { [TEXT_TURTLE]: 1 }},
      );

      // Parse quads
      const quads = await parseQuads(representation.data);
      const profile = extractProfileFromQuads(quads, webId);

      // Override email from account if available (account email takes precedence)
      if (email) {
        profile.email = email;
      }

      return {
        json: {
          webId,
          profile,
        },
      };
    } catch (error: unknown) {
      // If profile document doesn't exist, return empty profile with email
      if (error instanceof NotFoundHttpError) {
        return {
          json: {
            webId,
            profile: email ? { email } : {},
          },
        };
      }
      throw error;
    }
  }

  public async handle({ json, accountId }: JsonInteractionHandlerInput): Promise<JsonRepresentation<ProfileData>> {
    assertAccountId(accountId);

    // Validate input
    const validation = validateProfileData(json);
    if (!validation.valid) {
      throw new BadRequestHttpError(`Invalid profile data: ${validation.errors.join(', ')}`);
    }

    const profile = json as ProfileData;

    // Get WebID for this account
    const webIdLinks = await this.webIdStore.findLinks(accountId);
    if (webIdLinks.length === 0) {
      throw new BadRequestHttpError(
        'No WebID linked to this account. Please create a pod first by visiting the pod creation page.',
      );
    }

    const webId = webIdLinks[0].webId;
    const profileDocUrl = getProfileDocumentUrl(webId);
    const profileDocId = { path: profileDocUrl };

    // Get email from account and add it to profile (read-only, but we store it in RDF)
    let accountEmail: string | undefined;
    try {
      const passwordLogins = await this.passwordStore.findByAccount(accountId);
      if (passwordLogins.length > 0) {
        accountEmail = passwordLogins[0].email;
      }
    } catch (error: unknown) {
      this.logger.debug(`Could not retrieve email for account ${accountId}: ${createErrorMessage(error)}`);
    }

    // Handle image upload if photo is base64
    let photoUrl = profile.photo;
    if (profile.photo && /^data:image\/([^;]+);base64,/.test(profile.photo)) {
      const match = /^data:image\/([^;]+);base64,(.+)$/.exec(profile.photo);
      if (match) {
        const [ , format, base64Data ] = match;
        const imageBuffer = Buffer.from(base64Data, 'base64');

        // Determine content type
        const contentTypeMap: Record<string, string> = {
          jpeg: 'image/jpeg',
          jpg: 'image/jpeg',
          png: 'image/png',
          gif: 'image/gif',
          webp: 'image/webp',
        };
        const contentType = contentTypeMap[format.toLowerCase()] || 'image/jpeg';

        // Generate image URL in the pod (store in profile/images/ folder)
        // Extract pod base URL from WebID (e.g., http://localhost:3000/pod/profile/card#me -> http://localhost:3000/pod/)
        const webIdUrl = new URL(webId);
        const pathParts = webIdUrl.pathname.split('/profile');
        const podBaseUrl = `${webIdUrl.origin}${pathParts[0]}`;
        const imageId = v4();
        const imagePath = `${podBaseUrl}/profile/images/${imageId}.${format}`;
        const imageIdentifier = { path: imagePath };

        // Store the image
        const imageMetadata = new RepresentationMetadata(imageIdentifier, contentType);
        const imageData = guardedStreamFrom(imageBuffer);
        const imageRepresentation = new BasicRepresentation(imageData, imageMetadata, contentType, true);

        await this.resourceStore.setRepresentation(imageIdentifier, imageRepresentation);
        photoUrl = imagePath;

        this.logger.debug(`Uploaded profile image to ${imagePath}`);
      }
    }

    // Update profile with the processed photo URL and add email from account
    const profileWithPhoto = { ...profile, photo: photoUrl };
    if (accountEmail) {
      profileWithPhoto.email = accountEmail;
    }

    // Read existing profile document to get current quads
    let existingQuads: Quad[] = [];
    let documentExists = false;
    try {
      const representation = await this.resourceStore.getRepresentation(
        profileDocId,
        { type: { [TEXT_TURTLE]: 1 }},
      );
      existingQuads = await parseQuads(representation.data);
      documentExists = true;
    } catch (error: unknown) {
      // If document doesn't exist, we'll create it
      if (!(error instanceof NotFoundHttpError)) {
        throw error;
      }
    }

    if (documentExists) {
      // Create N3 patch for existing document
      const patchData = createProfilePatch(webId, profileWithPhoto, existingQuads);
      const n3PatchString = createN3PatchString(patchData.deletes, patchData.inserts, patchData.conditions);
      const patch: N3Patch = {
        ...patchData,
        binary: true,
        data: guardedStreamFrom(n3PatchString),
        metadata: new RepresentationMetadata(profileDocId, TEXT_N3),
        isEmpty: patchData.deletes.length === 0 && patchData.inserts.length === 0,
      };
      await this.resourceStore.modifyResource(profileDocId, patch);
    } else {
      // Create new document with initial profile data
      const webIdNode = DataFactory.namedNode(webId);
      const initialQuads: Quad[] = [
        // Basic profile structure
        DataFactory.quad(webIdNode, DataFactory.namedNode(`${RDF}type`), DataFactory.namedNode(`${FOAF}Person`)),
      ];

      // Add profile data as quads
      const patchData = createProfilePatch(webId, profileWithPhoto, []);
      initialQuads.push(...patchData.inserts);

      // Create representation with initial quads
      const metadata = new RepresentationMetadata(profileDocId, TEXT_TURTLE);
      const data = serializeQuads(initialQuads, TEXT_TURTLE);
      const representation = new BasicRepresentation(data, metadata, TEXT_TURTLE);

      await this.resourceStore.setRepresentation(profileDocId, representation);
    }

    this.logger.info(`Profile updated for WebID ${webId}`);

    return { json: { ...profile, photo: photoUrl }};
  }
}
