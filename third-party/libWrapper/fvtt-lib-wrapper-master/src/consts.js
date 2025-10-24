// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright © 2021 fvtt-lib-wrapper Rui Pinheiro

'use strict';


//*********************
// Package information
export const PACKAGE_ID    = 'lib-wrapper';
export const PACKAGE_TITLE = 'libWrapper';
export const HOOKS_SCOPE   = 'libWrapper';


//*********************
// Miscellaneous definitions

// This allows rollup to strip out all unit-test code from the release artifact
/*#if _ROLLUP
	export const IS_UNITTEST = false;
//#else */
	export const IS_UNITTEST = (typeof Game === 'undefined');
//#endif

export const PROPERTIES_CONFIGURABLE = IS_UNITTEST ? true : false;