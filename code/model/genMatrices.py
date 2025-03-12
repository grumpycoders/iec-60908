# This is basically https://en.wikiversity.org/wiki/Reed%E2%80%93Solomon_codes_for_coders
# which we use to generate the C1 and C2 Reed Solomon matrices at the end. The nodejs
# jqr-* packages are buggy, and won't be able to correct the erratas, and I'm not in
# the mood to debug them. So here we are.

def gf_mult_noLUT(x, y, prim=0):
    '''Multiplication in Galois Fields without using a precomputed look-up table (and thus it's slower)
    by using the standard carry-less multiplication + modular reduction using an irreducible prime polynomial'''

    ### Define bitwise carry-less operations as inner functions ###
    def cl_mult(x, y):
        '''Bitwise carry-less multiplication on integers'''
        z = 0
        i = 0
        while (y >> i) > 0:
            if y & (1 << i):
                z ^= x << i
            i += 1
        return z

    def bit_length(n):
        '''Compute the position of the most significant bit (1) of an integer. Equivalent to int.bit_length()'''
        bits = 0
        while n >> bits:
            bits += 1
        return bits

    def cl_div(dividend, divisor=None):
        '''Bitwise carry-less long division on integers and returns the remainder'''
        # Compute the position of the most significant bit for each integers
        dl1 = bit_length(dividend)
        dl2 = bit_length(divisor)
        # If the dividend is smaller than the divisor, just exit
        if dl1 < dl2:
            return dividend
        # Else, align the most significant 1 of the divisor to the most significant 1 of the dividend (by shifting the divisor)
        for i in range(dl1-dl2, -1, -1):
            # Check that the dividend is divisible (useless for the first iteration but important for the next ones)
            if dividend & (1 << i+dl2-1):
                # If divisible, then shift the divisor to align the most significant bits and XOR (carry-less subtraction)
                dividend ^= divisor << i
        return dividend

    ### Main GF multiplication routine ###

    # Multiply the gf numbers
    result = cl_mult(x, y)
    # Then do a modular reduction (ie, remainder from the division) with an irreducible primitive polynomial so that it stays inside GF bounds
    if prim > 0:
        result = cl_div(result, prim)

    return result


# Create list of 512 elements. In Python 2.6+, consider using bytearray
gf_exp = [0] * 512
gf_log = [0] * 256


def init_tables(prim=0x11d):
    '''Precompute the logarithm and anti-log tables for faster computation later, using the provided primitive polynomial.'''
    # prim is the primitive (binary) polynomial. Since it's a polynomial in the binary sense,
    # it's only in fact a single galois field value between 0 and 255, and not a list of gf values.
    global gf_exp, gf_log
    gf_exp = [0] * 512  # anti-log (exponential) table
    gf_log = [0] * 256  # log table
    # For each possible value in the galois field 2^8, we will pre-compute the logarithm and anti-logarithm (exponential) of this value
    x = 1
    for i in range(0, 255):
        gf_exp[i] = x  # compute anti-log for this value and store it in a table
        gf_log[x] = i  # compute log at the same time
        x = gf_mult_noLUT(x, 2, prim)

        # If you use only generator==2 or a power of 2, you can use the following which is faster than gf_mult_noLUT():
        # x <<= 1 # multiply by 2 (change 1 by another number y to multiply by a power of 2^y)
        # if x & 0x100: # similar to x >= 256, but a lot faster (because 0x100 == 256)
        # x ^= prim # substract the primary polynomial to the current value (instead of 255, so that we get a unique set made of coprime numbers), this is the core of the tables generation

    # Optimization: double the size of the anti-log table so that we don't need to mod 255 to
    # stay inside the bounds (because we will mainly use this table for the multiplication of two GF numbers, no more).
    for i in range(255, 512):
        gf_exp[i] = gf_exp[i - 255]
    return [gf_log, gf_exp]


def gf_add(x, y):
    return x ^ y


def gf_sub(x, y):
    # in binary galois field, subtraction is just the same as addition (since we mod 2)
    return x ^ y


def gf_mul(x, y):
    if x == 0 or y == 0:
        return 0
    # should be gf_exp[(gf_log[x]+gf_log[y])%255] if gf_exp wasn't oversized
    return gf_exp[gf_log[x] + gf_log[y]]


def gf_div(x, y):
    if y == 0:
        raise ZeroDivisionError()
    if x == 0:
        return 0
    return gf_exp[(gf_log[x] + 255 - gf_log[y]) % 255]


def gf_pow(x, power):
    return gf_exp[(gf_log[x] * power) % 255]


def gf_inverse(x):
    return gf_exp[255 - gf_log[x]]  # gf_inverse(x) == gf_div(1, x)


def gf_poly_add(p, q):
    r = [0] * max(len(p), len(q))
    for i in range(0, len(p)):
        r[i+len(r)-len(p)] = p[i]
    for i in range(0, len(q)):
        r[i+len(r)-len(q)] ^= q[i]
    return r


def gf_poly_mul(p, q):
    '''Multiply two polynomials, inside Galois Field'''
    # Pre-allocate the result array
    r = [0] * (len(p)+len(q)-1)
    # Compute the polynomial multiplication (just like the outer product of two vectors,
    # we multiply each coefficient of p with all coefficients of q)
    for j in range(0, len(q)):
        for i in range(0, len(p)):
            # equivalent to: r[i + j] = gf_add(r[i+j], gf_mul(p[i], q[j]))
            r[i+j] ^= gf_mul(p[i], q[j])
            # -- you can see it's your usual polynomial multiplication
    return r


def gf_poly_div(dividend, divisor):
    '''Fast polynomial division by using Extended Synthetic Division and optimized for GF(2^p) computations
    (doesn't work with standard polynomials outside of this galois field, see the Wikipedia article for generic algorithm).'''
    # CAUTION: this function expects polynomials to follow the opposite convention at decoding:
    # the terms must go from the biggest to lowest degree (while most other functions here expect
    # a list from lowest to biggest degree). eg: 1 + 2x + 5x^2 = [5, 2, 1], NOT [1, 2, 5]

    msg_out = list(dividend)  # Copy the dividend
    # normalizer = divisor[0] # precomputing for performance
    outer_range = range(0, len(dividend) - (len(divisor) - 1))
    inner_range = range(1, len(divisor))
    for i in outer_range:
        # msg_out[i] /= normalizer # for general polynomial division (when polynomials are non-monic), the usual way of using
        # synthetic division is to divide the divisor g(x) with its leading coefficient, but not needed here.
        coef = msg_out[i]  # precaching
        # return gf_exp[gf_log[x] + gf_log[y]] # should be gf_exp[(gf_log[x]+gf_log[y])%255] if gf_exp wasn't oversized
        # log(0) is undefined, so we need to avoid that case explicitly (and it's also a good optimization).
        if coef != 0:
            lc = gf_log[coef]
            for j in inner_range:  # in synthetic division, we always skip the first coefficient of the divisor,
                # because it's only used to normalize the dividend coefficient
                if divisor[j] != 0:  # log(0) is undefined
                    d = divisor[j]
                    ld = gf_log[d]
                    m = gf_exp[ld + lc]
                    # equivalent to the more mathematically correct
                    msg_out[i + j] ^= m
                    # (but xoring directly is faster): msg_out[i + j] += -divisor[j] * coef

    # The resulting msg_out contains both the quotient and the remainder, the remainder being the size of the divisor
    # (the remainder has necessarily the same degree as the divisor -- not length but degree == length-1 -- since it's
    # what we couldn't divide from the dividend), so we compute the index where this separation is, and return the quotient and remainder.
    separator = -(len(divisor)-1)
    # return quotient, remainder.
    return msg_out[:separator], msg_out[separator:]


def gf_poly_scale(p, x):
    r = [0] * len(p)
    for i in range(0, len(p)):
        r[i] = gf_mul(p[i], x)
    return r


def gf_poly_eval(poly, x):
    '''Evaluates a polynomial in GF(2^p) given the value for x. This is based on Horner's scheme for maximum efficiency.'''
    y = poly[0]
    for i in range(1, len(poly)):
        c = poly[i]
        y = gf_mul(y, x)
        y = gf_add(y, c)
    return y


def rs_generator_poly(nsym):
    '''Generate an irreducible generator polynomial (necessary to encode a message into Reed-Solomon)'''
    g = [1]
    for i in range(0, nsym):
        g = gf_poly_mul(g, [1, gf_pow(2, i)])
    return g


def rs_encode_msg(msg_in, nsym):
    '''Reed-Solomon main encoding function'''
    gen = rs_generator_poly(nsym)

    # Pad the message, then divide it by the irreducible generator polynomial
    _, remainder = gf_poly_div(msg_in + [0] * (len(gen)-1), gen)
    # The remainder is our RS code! Just append it to our original message to get our full codeword (this represents a polynomial of max 256 terms)
    msg_out = msg_in + remainder
    # Return the codeword
    return msg_out


def rs_calc_syndromes(msg, nsym):
    '''Given the received codeword msg and the number of error correcting symbols (nsym), computes the syndromes polynomial.
    Mathematically, it's essentially equivalent to a Fourrier Transform (Chien search being the inverse).
    '''
    # Note the "[0] +" : we add a 0 coefficient for the lowest degree (the constant). This effectively shifts the syndrome and will shift every computation depending on the syndromes (such as the errors locator polynomial, errors evaluator polynomial, etc. but not the errors positions).
    # This is not necessary, you can adapt subsequent computations to start from 0 instead of skipping the first iteration (ie, the often seen range(1, n-k+1)),
    synd = [0] * nsym
    for i in range(0, nsym):
        synd[i] = gf_poly_eval(msg, gf_pow(2, i))
    # pad with one 0 for mathematical precision (else we can end up with weird calculations sometimes)
    return [0] + synd


def rs_forney_syndromes(synd, pos, nmess, nsym):
    # Compute Forney syndromes, which computes a modified syndromes to compute only errors (erasures are trimmed out). Do not confuse this with Forney algorithm, which allows correcting the message based on the location of errors.
    # prepare the coefficient degree positions (instead of the erasures positions)
    erase_pos_reversed = [nmess-1-p for p in pos]

    # Optimized method, all operations are inlined
    # fsynd = list(synd[1:])      # make a copy and trim the first coefficient which is always 0 by definition
    # for i in range(0, len(pos)):
    #    x = gf_pow(2, erase_pos_reversed[i])
    #    for j in range(0, len(fsynd) - 1):
    #        fsynd[j] = gf_mul(fsynd[j], x) ^ fsynd[j + 1]

    # Equivalent, theoretical way of computing the modified Forney syndromes: fsynd = (erase_loc * synd) % x^(n-k)
    # See Shao, H. M., Truong, T. K., Deutsch, L. J., & Reed, I. S. (1986, April). A single chip VLSI Reed-Solomon decoder. In Acoustics, Speech, and Signal Processing, IEEE International Conference on ICASSP'86. (Vol. 11, pp. 2151-2154). IEEE.ISO 690
    # computing the erasures locator polynomial
    erase_loc = rs_find_errata_locator(erase_pos_reversed)
    # then multiply with the syndrome to get the untrimmed forney syndrome
    fsynd = gf_poly_mul(erase_loc[::-1], synd[1:])
    # then trim the first erase_pos coefficients which are useless. Seems to be not necessary, but this reduces the computation time later in BM (thus it's an optimization).
    fsynd = fsynd[len(pos):]

    return fsynd


def rs_find_error_locator(synd, nsym, erase_loc=None, erase_count=0):
    '''Find error/errata locator and evaluator polynomials with Berlekamp-Massey algorithm'''
    # The idea is that BM will iteratively estimate the error locator polynomial.
    # To do this, it will compute a Discrepancy term called Delta, which will tell us if the error locator polynomial needs an update or not
    # (hence why it's called discrepancy: it tells us when we are getting off board from the correct value).

    # Init the polynomials
    if erase_loc:  # if the erasure locator polynomial is supplied, we init with its value, so that we include erasures in the final locator polynomial
        err_loc = list(erase_loc)
        old_loc = list(erase_loc)
    else:
        # This is the main variable we want to fill, also called Sigma in other notations or more formally the errors/errata locator polynomial.
        err_loc = [1]
        # BM is an iterative algorithm, and we need the errata locator polynomial of the previous iteration in order to update other necessary variables.
        old_loc = [1]
    # L = 0 # update flag variable, not needed here because we use an alternative equivalent way of checking if update is needed (but using the flag could potentially be faster depending on if using length(list) is taking linear time in your language, here in Python it's constant so it's as fast.

    # Fix the syndrome shifting: when computing the syndrome, some implementations may prepend a 0 coefficient for the lowest degree term (the constant). This is a case of syndrome shifting, thus the syndrome will be bigger than the number of ecc symbols (I don't know what purpose this shifting serves). If that's the case, then we need to account for the syndrome shifting when we use the syndrome such as inside BM, by skipping those prepended coefficients.
    # Another way to detect the shifting is to detect the 0 coefficients: by definition, a syndrome does not contain any 0 coefficient (except if there are no errors/erasures, in this case they are all 0). This however doesn't work with the modified Forney syndrome, which set to 0 the coefficients corresponding to erasures, leaving only the coefficients corresponding to errors.
    synd_shift = 0
    if len(synd) > nsym:
        synd_shift = len(synd) - nsym

    # generally: nsym-erase_count == len(synd), except when you input a partial erase_loc and using the full syndrome instead of the Forney syndrome, in which case nsym-erase_count is more correct (len(synd) will fail badly with IndexError).
    for i in range(0, nsym-erase_count):
        # if an erasures locator polynomial was provided to init the errors locator polynomial, then we must skip the FIRST erase_count iterations (not the last iterations, this is very important!)
        if erase_loc:
            K = erase_count+i+synd_shift
        # if erasures locator is not provided, then either there's no erasures to account or we use the Forney syndromes, so we don't need to use erase_count nor erase_loc (the erasures have been trimmed out of the Forney syndromes).
        else:
            K = i+synd_shift

        # Compute the discrepancy Delta
        # Here is the close-to-the-books operation to compute the discrepancy Delta: it's a simple polynomial multiplication of error locator with the syndromes, and then we get the Kth element.
        # delta = gf_poly_mul(err_loc[::-1], synd)[K] # theoretically it should be gf_poly_add(synd[::-1], [1])[::-1] instead of just synd, but it seems it's not absolutely necessary to correctly decode.
        # But this can be optimized: since we only need the Kth element, we don't need to compute the polynomial multiplication for any other element but the Kth. Thus, to optimize, we compute the polymul only at the item we need, skipping the rest (avoiding a nested loop, thus we are linear time instead of quadratic).
        # This optimization is actually described in several figures of the book "Algebraic codes for data transmission", Blahut, Richard E., 2003, Cambridge university press.
        delta = synd[K]
        for j in range(1, len(err_loc)):
            # delta is also called discrepancy. Here we do a partial polynomial multiplication (ie, we compute the polynomial multiplication only for the term of degree K). Should be equivalent to brownanrs.polynomial.mul_at().
            delta ^= gf_mul(err_loc[-(j+1)], synd[K - j])
        # print "delta", K, delta, list(gf_poly_mul(err_loc[::-1], synd)) # debugline

        # Shift polynomials to compute the next degree
        old_loc = old_loc + [0]

        # Iteratively estimate the errata locator and evaluator polynomials
        if delta != 0:  # Update only if there's a discrepancy
            # Rule B (rule A is implicitly defined because rule A just says that we skip any modification for this iteration)
            if len(old_loc) > len(err_loc):
                # if 2*L <= K+erase_count: # equivalent to len(old_loc) > len(err_loc), as long as L is correctly computed
                # Computing errata locator polynomial Sigma
                new_loc = gf_poly_scale(old_loc, delta)
                # effectively we are doing err_loc * 1/delta = err_loc // delta
                old_loc = gf_poly_scale(err_loc, gf_inverse(delta))
                err_loc = new_loc
                # Update the update flag
                # L = K - L # the update flag L is tricky: in Blahut's schema, it's mandatory to use `L = K - L - erase_count` (and indeed in a previous draft of this function, if you forgot to do `- erase_count` it would lead to correcting only 2*(errors+erasures) <= (n-k) instead of 2*errors+erasures <= (n-k)), but in this latest draft, this will lead to a wrong decoding in some cases where it should correctly decode! Thus you should try with and without `- erase_count` to update L on your own implementation and see which one works OK without producing wrong decoding failures.

            # Update with the discrepancy
            err_loc = gf_poly_add(err_loc, gf_poly_scale(old_loc, delta))

    # Check if the result is correct, that there's not too many errors to correct
    while len(err_loc) and err_loc[0] == 0:
        # drop leading 0s, else errs will not be of the correct size
        del err_loc[0]
    errs = len(err_loc) - 1
    if (errs-erase_count) * 2 + erase_count > nsym:
        # too many errors to correct
        raise ReedSolomonError("Too many errors to correct")

    return err_loc


def rs_find_errors(err_loc, nmess):  # nmess is len(msg_in)
    '''Find the roots (ie, where evaluation = zero) of error polynomial by brute-force trial, this is a sort of Chien's search
    (but less efficient, Chien's search is a way to evaluate the polynomial such that each evaluation only takes constant time).'''
    errs = len(err_loc) - 1
    err_pos = []
    for i in range(nmess):  # normally we should try all 2^8 possible values, but here we optimize to just check the interesting symbols
        # It's a 0? Bingo, it's a root of the error locator polynomial,
        if gf_poly_eval(err_loc, gf_pow(2, i)) == 0:
            # in other terms this is the location of an error
            err_pos.append(nmess - 1 - i)
    # Sanity check: the number of errors/errata positions found should be exactly the same as the length of the errata locator polynomial
    if len(err_pos) != errs:
        # couldn't find error locations
        raise ReedSolomonError(
            "Too many (or few) errors found by Chien Search for the errata locator polynomial!")
    return err_pos


def rs_find_error_evaluator(synd, err_loc, nsym):
    '''Compute the error (or erasures if you supply sigma=erasures locator polynomial, or errata) evaluator polynomial Omega
       from the syndrome and the error/erasures/errata locator Sigma.'''

    # Omega(x) = [ Synd(x) * Error_loc(x) ] mod x^(n-k+1)
    m = gf_poly_mul(synd, err_loc)
    # first multiply syndromes * errata_locator, then do a
    _, remainder = gf_poly_div(m, ([1] + [0]*(nsym+1)))
    # polynomial division to truncate the polynomial to the
    # required length

    # Faster way that is equivalent
    # remainder = gf_poly_mul(synd, err_loc) # first multiply the syndromes with the errata locator polynomial
    # remainder = remainder[len(remainder)-(nsym+1):] # then slice the list to truncate it (which represents the polynomial), which
    # is equivalent to dividing by a polynomial of the length we want

    return remainder


def rs_find_errata_locator(e_pos):
    '''Compute the erasures/errors/errata locator polynomial from the erasures/errors/errata positions
       (the positions must be relative to the x coefficient, eg: "hello worldxxxxxxxxx" is tampered to "h_ll_ worldxxxxxxxxx"
       with xxxxxxxxx being the ecc of length n-k=9, here the string positions are [1, 4], but the coefficients are reversed
       since the ecc characters are placed as the first coefficients of the polynomial, thus the coefficients of the
       erased characters are n-1 - [1, 4] = [18, 15] = erasures_loc to be specified as an argument.'''

    e_loc = [1]  # just to init because we will multiply, so it must be 1 so that the multiplication starts correctly without nulling any term
    # erasures_loc = product(1 - x*alpha**i) for i in erasures_pos and where alpha is the alpha chosen to evaluate polynomials.
    for i in e_pos:
        e_loc = gf_poly_mul(e_loc, gf_poly_add([1], [gf_pow(2, i), 0]))
    return e_loc


# err_pos is a list of the positions of the errors/erasures/errata
def rs_correct_errata(msg_in, synd, err_pos):
    '''Forney algorithm, computes the values (error magnitude) to correct the input message.'''
    # calculate errata locator polynomial to correct both errors and erasures (by combining the errors positions given by the error locator polynomial found by BM with the erasures positions given by caller)
    # need to convert the positions to coefficients degrees for the errata locator algo to work (eg: instead of [0, 1, 2] it will become [len(msg)-1, len(msg)-2, len(msg) -3])
    coef_pos = [len(msg_in) - 1 - p for p in err_pos]
    err_loc = rs_find_errata_locator(coef_pos)
    # calculate errata evaluator polynomial (often called Omega or Gamma in academic papers)
    err_eval = rs_find_error_evaluator(
        synd[::-1], err_loc, len(err_loc)-1)[::-1]

    # Second part of Chien search to get the error location polynomial X from the error positions in err_pos (the roots of the error locator polynomial, ie, where it evaluates to 0)
    X = []  # will store the position of the errors
    for i in range(0, len(coef_pos)):
        l = 255 - coef_pos[i]
        X.append(gf_pow(2, -l))

    # Forney algorithm: compute the magnitudes
    # will store the values that need to be corrected (substracted) to the message containing errors. This is sometimes called the error magnitude polynomial.
    E = [0] * (len(msg_in))
    Xlength = len(X)
    for i, Xi in enumerate(X):

        Xi_inv = gf_inverse(Xi)

        # Compute the formal derivative of the error locator polynomial (see Blahut, Algebraic codes for data transmission, pp 196-197).
        # the formal derivative of the errata locator is used as the denominator of the Forney Algorithm, which simply says that the ith error value is given by error_evaluator(gf_inverse(Xi)) / error_locator_derivative(gf_inverse(Xi)). See Blahut, Algebraic codes for data transmission, pp 196-197.
        err_loc_prime_tmp = []
        for j in range(0, Xlength):
            if j != i:
                err_loc_prime_tmp.append(gf_sub(1, gf_mul(Xi_inv, X[j])))
        # compute the product, which is the denominator of the Forney algorithm (errata locator derivative)
        err_loc_prime = 1
        for coef in err_loc_prime_tmp:
            err_loc_prime = gf_mul(err_loc_prime, coef)
        # equivalent to: err_loc_prime = functools.reduce(gf_mul, err_loc_prime_tmp, 1)

        # Compute y (evaluation of the errata evaluator polynomial)
        # This is a more faithful translation of the theoretical equation contrary to the old forney method. Here it is an exact reproduction:
        # Yl = omega(Xl.inverse()) / prod(1 - Xj*Xl.inverse()) for j in len(X)
        # numerator of the Forney algorithm (errata evaluator evaluated)
        y = gf_poly_eval(err_eval[::-1], Xi_inv)
        y = gf_mul(gf_pow(Xi, 1), y)

        # Check: err_loc_prime (the divisor) should not be zero.
        if err_loc_prime == 0:
            # Could not find error magnitude
            raise ReedSolomonError("Could not find error magnitude")

        # Compute the magnitude
        # magnitude value of the error, calculated by the Forney algorithm (an equation in fact): dividing the errata evaluator with the errata locator derivative gives us the errata magnitude (ie, value to repair) the ith symbol
        magnitude = gf_div(y, err_loc_prime)
        # store the magnitude for this error into the magnitude polynomial
        E[err_pos[i]] = magnitude

    # Apply the correction of values to get our message corrected! (note that the ecc bytes also get corrected!)
    # (this isn't the Forney algorithm, we just apply the result of decoding here)
    # equivalent to Ci = Ri - Ei where Ci is the correct message, Ri the received (senseword) message, and Ei the errata magnitudes (minus is replaced by XOR since it's equivalent in GF(2^p)). So in fact here we substract from the received message the errors magnitude, which logically corrects the value to what it should be.
    msg_in = gf_poly_add(msg_in, E)
    return msg_in


def rs_correct_msg(msg_in, nsym, erase_pos=None):
    '''Reed-Solomon main decoding function'''
    if len(msg_in) > 255:  # can't decode, message is too big
        raise ValueError(
            "Message is too long (%i when max is 255)" % len(msg_in))

    msg_out = list(msg_in)     # copy of message
    # erasures: set them to null bytes for easier decoding (but this is not necessary, they will be corrected anyway, but debugging will be easier with null bytes because the error locator polynomial values will only depend on the errors locations, not their values)
    if erase_pos is None:
        erase_pos = []
    else:
        for e_pos in erase_pos:
            msg_out[e_pos] = 0
    # check if there are too many erasures to correct (beyond the Singleton bound)
    if len(erase_pos) > nsym:
        raise ReedSolomonError("Too many erasures to correct")
    # prepare the syndrome polynomial using only errors (ie: errors = characters that were either replaced by null byte
    # or changed to another character, but we don't know their positions)
    synd = rs_calc_syndromes(msg_out, nsym)
    # check if there's any error/erasure in the input codeword. If not (all syndromes coefficients are 0), then just return the message as-is.
    if max(synd) == 0:
        return msg_out[:-nsym], msg_out[-nsym:]  # no errors

    # compute the Forney syndromes, which hide the erasures from the original syndrome (so that BM will just have to deal with errors, not erasures)
    fsynd = rs_forney_syndromes(synd, erase_pos, len(msg_out), nsym)
    # compute the error locator polynomial using Berlekamp-Massey
    err_loc = rs_find_error_locator(fsynd, nsym, erase_count=len(erase_pos))
    # locate the message errors using Chien search (or brute-force search)
    err_pos = rs_find_errors(err_loc[::-1], len(msg_out))
    if err_pos is None:
        # error location failed
        raise ReedSolomonError("Could not locate error")

    # Find errors values and apply them to correct the message
    # compute errata evaluator and errata magnitude polynomials, then correct errors and erasures
    # note that here we use the original syndrome, not the forney syndrome
    msg_out = rs_correct_errata(msg_out, synd, (erase_pos + err_pos))
    # (because we will correct both errors and erasures, so we need the full syndrome)
    # check if the final message is fully repaired
    synd = rs_calc_syndromes(msg_out, nsym)
    if max(synd) > 0:
        # message could not be repaired
        raise ReedSolomonError("Could not correct message")
    # return the successfully decoded message
    # also return the corrected ecc block so that the user can check()
    return msg_out[:-nsym], msg_out[-nsym:]


init_tables(0x11d)

# Generate the matrix values for C1, by forcing the repair of 4 messages
# with 4 erasures, in a square identity matrix.
# This is if one wants to use the same exact algorithm to compute C1 and C2,
# but this means a bit more overhead than the division-based encoders.
print("C1 data:")
for i in range(0, 28):
    m = [0] * 32
    m[i] = 1
    c, e = rs_correct_msg(m, 4, [28, 29, 30, 31])
    s = [gf_log[x] for x in e]
    print("    0x%s," % ', 0x'.join('{:02x}'.format(x) for x in s))

# Since the parity bytes are in the middle instead of the end, we
# can't use the normal division-based encoders for C2, and we'll go
# with the systematic approach. To generate the matrix, we're going
# to force repairing 24 messages forming a weird identity matrix,
# with 4 zeroes in the middle that we'll set as erasures.
# As a result, calculating C2 will always be a bit more expensive
# than the other reed solomon computations, due to the extra matrix
# operation overhead.
# Also it won't be generic either, as the division can simply slide
# the encoded bytes forever.
print("C2 data:")
for i in range(0, 24):
    m = [0] * 28
    if (i < 12):
        m[i] = 1
    else:
        m[i + 4] = 1
    c, e = rs_correct_msg(m, 4, [12, 13, 14, 15])
    s = [gf_log[x] for x in (c + e)[12:16]]
    print("    0x%s," % ', 0x'.join('{:02x}'.format(x) for x in s))
